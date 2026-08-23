"""hopeos-sign-serve — public static host for the trained SignNet weights.

A dedicated, PERSISTENTLY DEPLOYED (not ephemeral) app — separate lifecycle
from the hopeos-sign training pipeline, which runs one-off jobs. This one
just serves two small static files with CORS + long-lived immutable
caching, so signlab.html can fetch() them cross-origin from wherever it's
actually hosted (GitHub Pages, Netlify, localhost).

Deploy (persistent, survives local disconnect — unlike `modal run`):
  py -m modal deploy tools/sign-train/serve_model.py
Prints the live URL, something like:
  https://kennyairepo--hopeos-sign-serve-web.modal.run

Versioned path (/v1/...) is the cache-bust mechanism from the integration
plan: shipping a better checkpoint later means re-running this deploy with
files copied to /v2/ instead of touching /v1/, so already-cached clients on
v1 keep working untouched while new clients pick up v2 at a new URL.
"""
import modal
from pathlib import Path

app = modal.App("hopeos-sign-serve")

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
MODELS_DIR = REPO_ROOT / "assets" / "models"
VERSION = "v1"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("fastapi[standard]")
    .add_local_file(str(MODELS_DIR / "signnet.onnx"), f"/assets/{VERSION}/signnet.onnx")
    .add_local_file(str(MODELS_DIR / "labels.json"), f"/assets/{VERSION}/labels.json")
)


@app.function(image=image)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, Response
    from fastapi.middleware.cors import CORSMiddleware

    api = FastAPI()
    api.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

    IMMUTABLE = {"cache-control": "public, max-age=31536000, immutable"}

    @api.get(f"/{VERSION}/signnet.onnx")
    def get_model():
        data = (Path(f"/assets/{VERSION}") / "signnet.onnx").read_bytes()
        return Response(content=data, media_type="application/octet-stream", headers=IMMUTABLE)

    @api.get(f"/{VERSION}/labels.json")
    def get_labels():
        data = (Path(f"/assets/{VERSION}") / "labels.json").read_bytes()
        return Response(content=data, media_type="application/json", headers=IMMUTABLE)

    @api.get("/")
    def health():
        return {"ok": True, "version": VERSION}

    return api
