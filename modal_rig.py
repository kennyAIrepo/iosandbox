"""
hopeos-rig — SAM 3D Body "rig lane" on Modal (low-latency websocket).

Wire contract (matches the node's sam3_serve.py rig lane exactly):

  WS /ws:
    binary in : 8-byte LE float64 capture-time (cts) + JPEG
    text in   : {"cmd":"rig","on":0|1}   (default ON; unknown cmds ignored)
    text out  : {"rigst":"loading"}                       while model warms
                first success adds {"rig_topo":{"nv":int,"faces":"<b64 u16>"}}
                every inference:
                {"rig":{"seq","id","nv","vmin","vmax","q","cam_t","focal",
                        "box","iw","ih","ms"},
                 "cts":<echoed>, "ms":<total>, "rigst":"live", "body2D":[...]}

Latest-frame-only: frames arriving while busy are dropped, never queued.

st-22 latency pass:
  · bf16 autocast over the whole pipeline (fp32 auto-fallback on any
    non-finite output) — ~3.5× on the ViT-H encoder passes.
  · inference stays "full" (body + both hand decoders): a "body"-only trial
    was 95ms but finger pose visibly died — hands matter more than the delta.
  · YOLO person detect at imgsz=640 (was 960) — detection only, box accuracy
    at 640 is plenty for a top-down crop.
  · torch.cuda.empty_cache() is called at the top of every process_one_image
    inside sam-3d-body; on a dedicated single-model server that only thrashes
    the allocator — no-opped after load.
  · TF32 matmul + cudnn.benchmark on.

Deploy:  modal deploy modal_rig.py
URL:     https://kennyairepo--hopeos-rig-rig-web.modal.run
"""
import base64
import json
import struct
import threading
import time
import traceback

import modal

app = modal.App("hopeos-rig")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .pip_install("torch==2.7.1", "torchvision==0.22.1")
    .pip_install(
        "numpy", "opencv-python-headless", "fastapi[standard]", "uvicorn",
        "huggingface_hub", "fast_simplification", "pyrootutils", "timm",
        "roma", "braceexpand", "omegaconf", "trimesh", "pyrender", "einops",
        "av", "yacs", "pytorch-lightning", "ultralytics",
    )
    .run_commands(
        "git clone --depth 1 https://github.com/facebookresearch/sam-3d-body /root/sam-3d-body",
        # bake the pose detector weights into the image
        "cd /root && YOLO_CONFIG_DIR=/tmp/yolo python -c \"from ultralytics import YOLO; YOLO('yolo11n-pose.pt')\"",
    )
    .env({"HF_HOME": "/cache", "PYTHONPATH": "/root/sam-3d-body",
          "YOLO_CONFIG_DIR": "/tmp/yolo"})
)
cache = modal.Volume.from_name("hopeos-hf-cache", create_if_missing=True)

HF_REPO = "facebook/sam-3d-body-vith"
CKPT_DIR = "/cache/sam-3d-body-vith"


@app.cls(gpu="L40S", image=image, volumes={"/cache": cache},
         secrets=[modal.Secret.from_name("hopeos-hf")],
         scaledown_window=300, timeout=3600)
@modal.concurrent(max_inputs=10)
class Rig:
    @modal.enter()
    def boot(self):
        # Load in a background thread so the websocket can accept immediately
        # and report {"rigst":"loading"} instead of stalling the handshake.
        self.ready = threading.Event()
        self.load_err = None
        self.gpu_lock = threading.Lock()
        self.amp = True
        self.topo_lock = threading.Lock()
        self.est = None
        self.pose = None
        self.faces_full = None
        self.sel = None
        self.faces_b64 = None
        self.nv = 0
        threading.Thread(target=self._load, daemon=True).start()

    # ------------------------------------------------------------- load
    def _load(self):
        try:
            import numpy as np
            import torch
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
            torch.backends.cudnn.benchmark = True
            t0 = time.time()
            from huggingface_hub import snapshot_download
            ckpt_dir = snapshot_download(HF_REPO, local_dir=CKPT_DIR)
            cache.commit()
            print(f"rig: weights ready in {time.time()-t0:.1f}s -> {ckpt_dir}", flush=True)

            from ultralytics import YOLO
            self.pose = YOLO("/root/yolo11n-pose.pt")
            self.pose.predict(np.zeros((544, 960, 3), np.uint8), verbose=False)  # warmup

            # ---- exact port of the node's _rig_load_sync ----
            from sam_3d_body import load_sam_3d_body, SAM3DBodyEstimator
            import inspect as _i
            m, cfg = load_sam_3d_body(
                ckpt_dir + "/model.ckpt", mhr_path=ckpt_dir + "/assets/mhr_model.pt")
            p = _i.signature(SAM3DBodyEstimator.__init__).parameters
            est = SAM3DBodyEstimator(m, model_cfg=cfg) if "model_cfg" in p else SAM3DBodyEstimator(m, cfg)
            faces = None
            for path in ("head_pose", "mhr_head", "head"):
                h = getattr(m, path, None)
                if h is not None and hasattr(h, "faces"):
                    faces = h.faces.detach().cpu().numpy().astype(np.int64); break
            self.est = est
            self.faces_full = faces
            # sam-3d-body calls torch.cuda.empty_cache() every frame — on a
            # dedicated server that's pure allocator churn (tens of ms/frame)
            torch.cuda.empty_cache = lambda *a, **k: None
            print(f"rig: 3DB loaded in {time.time()-t0:.1f}s, "
                  f"faces {None if faces is None else faces.shape}", flush=True)
        except Exception:
            self.load_err = traceback.format_exc()
            print("rig: LOAD FAILED\n" + self.load_err, flush=True)
        finally:
            self.ready.set()

    # ------------------------------------------------------------- topo
    def _build_topo(self, verts):
        """First result -> decimate once, build the fixed vertex-index map.
        (exact port of the node's _rig_build_topo)"""
        import numpy as np
        import fast_simplification as fs
        v2, f2 = fs.simplify(verts.astype(np.float32),
                             self.faces_full.astype(np.int64), target_reduction=0.85)
        sel = np.empty(len(v2), dtype=np.int64)      # nearest original vertex per decimated vertex
        for i in range(0, len(v2), 256):             # chunked brute force (runs once)
            d = ((verts[None, :, :] - v2[i:i + 256, None, :]) ** 2).sum(-1)
            sel[i:i + 256] = d.argmin(1)
        self.sel = sel
        self.faces_b64 = base64.b64encode(f2.astype(np.uint16).tobytes()).decode()
        self.nv = len(v2)
        print(f"rig: topo built — {len(v2)} verts / {len(f2)} faces "
              f"(from {len(verts)})", flush=True)

    # ------------------------------------------------------------- infer
    @staticmethod
    def _np(x):
        import numpy as np
        if hasattr(x, "detach"):
            x = x.detach().float().cpu().numpy()   # .float(): numpy has no bf16
        return np.asarray(x)

    def _process(self, jpg):
        """Decode JPEG -> detect person box (+body2D) -> SAM 3D Body -> packet.
        Runs in a worker thread; returns (packet_without_seq, body2D)."""
        import cv2
        import numpy as np
        img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("bad jpeg")
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        h, w = rgb.shape[:2]

        with self.gpu_lock:
            # person detector: biggest-bbox person + pose keypoints
            box = None
            body2d = None
            try:
                r = self.pose.predict(rgb, imgsz=640, conf=0.05, verbose=False)[0]
                if r.boxes is not None and len(r.boxes):
                    xyxy = r.boxes.xyxy.cpu().numpy()
                    areas = (xyxy[:, 2] - xyxy[:, 0]) * (xyxy[:, 3] - xyxy[:, 1])
                    bi = int(areas.argmax())
                    box = xyxy[bi].astype(np.float32)
                    kobj = r.keypoints
                    if kobj is not None:
                        k = kobj.xyn[bi].tolist()
                        kc = kobj.conf[bi].tolist() if kobj.conf is not None else [0] * len(k)
                        body2d = [{"x": round(px, 4), "y": round(py, 4), "score": round(c, 2)}
                                  for (px, py), c in zip(k, kc)]
            except Exception as e:
                print("pose detect failed:", type(e).__name__, str(e)[:120], flush=True)
            if box is None:
                box = np.array([0, 0, w, h], np.float32)   # full-frame fallback
            box = box.reshape(1, 4)

            # ---- exact port of the node's rig_infer + packet build ----
            t0 = time.time()
            # "full" keeps the hand decoders — st-22 briefly ran "body"-only
            # (3× less encoder work) but finger pose visibly died; bf16 buys
            # the speed back instead. One non-finite result permanently drops
            # back to fp32.
            import torch
            out = None
            if self.amp:
                try:
                    with torch.autocast("cuda", dtype=torch.bfloat16):
                        out = self.est.process_one_image(
                            rgb, bboxes=box, inference_type="full")
                    ov = out[0] if isinstance(out, (list, tuple)) else out
                    if not np.isfinite(self._np(ov["pred_vertices"])).all():
                        raise ValueError("non-finite verts under bf16")
                except Exception as e:
                    print("amp off:", type(e).__name__, str(e)[:160], flush=True)
                    self.amp = False
                    out = None
            if out is None:
                out = self.est.process_one_image(rgb, bboxes=box)
            o = out[0] if isinstance(out, (list, tuple)) else out
            verts = np.asarray(self._np(o["pred_vertices"]), np.float32)
            if self.sel is None:
                with self.topo_lock:
                    if self.sel is None:
                        self._build_topo(verts)
            v = verts[self.sel]
            vmin = v.min(0); vmax = v.max(0); rng = np.maximum(vmax - vmin, 1e-6)
            q = ((v - vmin) / rng * 65535).astype(np.uint16)
            pkt = {
                "id": 0, "nv": self.nv,
                "vmin": [round(float(x), 4) for x in vmin],
                "vmax": [round(float(x), 4) for x in vmax],
                "q": base64.b64encode(q.tobytes()).decode(),
                "cam_t": [round(float(x), 4) for x in self._np(o["pred_cam_t"]).ravel()],
                "focal": round(float(self._np(o["focal_length"]).ravel()[0]), 2),
                "box": [round(float(x), 2) for x in box[0]], "iw": w, "ih": h,
                "ms": round((time.time() - t0) * 1000, 1),
            }
        return pkt, body2d

    # ------------------------------------------------------------- web
    @modal.asgi_app()
    def web(self):
        import asyncio
        from fastapi import FastAPI, WebSocket, WebSocketDisconnect

        api = FastAPI()

        @api.get("/healthz")
        async def healthz():
            return {"ready": self.ready.is_set() and self.est is not None,
                    "err": (self.load_err or "")[-400:] or None}

        @api.websocket("/ws")
        async def ws(sock: WebSocket):
            await sock.accept()
            on = True                       # rig lane defaults ON
            latest = {"frame": None}        # (cts, jpg) — LATEST only, never queued
            kick = asyncio.Event()
            sent_topo = False
            seq = 0
            last_loading = 0.0
            if not (self.ready.is_set() and self.est is not None):
                await sock.send_text(json.dumps({"rigst": "loading"}))
                last_loading = time.time()

            async def worker():
                nonlocal sent_topo, seq, last_loading
                while True:
                    await kick.wait(); kick.clear()
                    item = latest["frame"]; latest["frame"] = None
                    if item is None or not on:
                        continue
                    cts, jpg = item
                    if not self.ready.is_set() or self.est is None:
                        if self.load_err:
                            await sock.send_text(json.dumps(
                                {"rigst": "error", "err": self.load_err[-300:]}))
                            return
                        if time.time() - last_loading > 2.0:
                            await sock.send_text(json.dumps({"rigst": "loading"}))
                            last_loading = time.time()
                        continue
                    t_all = time.time()
                    try:
                        pkt, body2d = await asyncio.to_thread(self._process, jpg)
                    except Exception as e:
                        print("rig step failed:", type(e).__name__, str(e)[:200], flush=True)
                        continue
                    seq += 1
                    pkt = {"seq": seq, **pkt}
                    msg = {"rig": pkt, "cts": cts,
                           "ms": round((time.time() - t_all) * 1000, 1),
                           "rigst": "live"}
                    if body2d is not None:
                        msg["body2D"] = body2d
                    if not sent_topo and self.faces_b64:
                        msg["rig_topo"] = {"nv": self.nv, "faces": self.faces_b64}
                        sent_topo = True
                    await sock.send_text(json.dumps(msg))

            wtask = asyncio.create_task(worker())
            try:
                while True:
                    msg = await sock.receive()
                    if msg.get("bytes") is not None:
                        raw = msg["bytes"]
                        if len(raw) < 9:
                            continue
                        cts = struct.unpack("<d", raw[:8])[0]
                        latest["frame"] = (cts, raw[8:])
                        kick.set()
                    elif msg.get("text"):
                        try:
                            c = json.loads(msg["text"])
                        except Exception:
                            continue
                        if c.get("cmd") == "rig":
                            on = bool(c.get("on", 1))
                    elif msg.get("type") == "websocket.disconnect":
                        break
            except WebSocketDisconnect:
                pass
            finally:
                wtask.cancel()

        return api
