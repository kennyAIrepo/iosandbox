/**
 * hopeOS SDK — World Graph
 * ═══════════════════════════════════════════════════════════════
 * A neon-green node graph of worlds. Each world is a circle (thumbnail inside,
 * title beneath) wired to its nearest neighbours by glowing lines. Drag a node
 * to move it; drag empty space to pan the whole graph; click a node to open it.
 *
 *   mountWorldGraph(canvas, items, { onOpen });
 *   // items: [{ id, title, thumb?:dataURL|url, sub?:string }]
 *
 * Pure 2D canvas, no deps. Matrix palette (#04070a void, #5dff9b green).
 */

const GREEN = '93,255,155', CYAN = '120,250,210', DIM = '47,162,98';

export function mountWorldGraph(canvas, items, opts = {}) {
  const ctx = canvas.getContext('2d');
  const onOpen = opts.onOpen || (() => {});
  let W = 0, H = 0, dpr = Math.min(devicePixelRatio || 1, 2.5);

  // ── Nodes: golden-angle spiral spread so they fill the space evenly ──
  const R = 58;                                   // node radius (px, world space) — bigger = clearer thumbs/titles
  const nodes = items.map((it, i) => {
    const ga = i * 2.39996323;                    // golden angle
    const rad = 30 + 116 * Math.sqrt(i);
    return {
      it, r: R,
      x: Math.cos(ga) * rad, y: Math.sin(ga) * rad,
      img: null, imgReady: false,
      phase: (i * 1.7) % 6.283,
    };
  });
  loadThumbs(nodes);

  // ── Connections: each node to its 2 nearest neighbours (dedup) ──
  const edges = [];
  const seen = new Set();
  nodes.forEach((a, i) => {
    const near = nodes.map((b, j) => ({ j, d: (a.x - b.x) ** 2 + (a.y - b.y) ** 2 }))
      .filter(o => o.j !== i).sort((p, q) => p.d - q.d).slice(0, 2);
    near.forEach(({ j }) => { const key = i < j ? i + '-' + j : j + '-' + i; if (!seen.has(key)) { seen.add(key); edges.push([i, j]); } });
  });

  // ── View transform (pan + zoom) + interaction state ──
  let panX = 0, panY = 0, scale = 1;
  let userMoved = false;    // once the user pans/zooms, stop auto-fitting on resize
  let drag = null;          // { idx, startX, startY, moved }
  let hover = -1;
  const toWorld = (cx, cy) => ({ x: (cx - W / 2 - panX) / scale, y: (cy - H / 2 - panY) / scale });
  // A node is hit by its circle OR its title band below it (so the label is clickable too).
  const hit = (wx, wy) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i], dx = wx - n.x;
      if (dx * dx + (wy - n.y) ** 2 <= (n.r + 8) ** 2) return i;
      if (Math.abs(dx) < n.r + 34 && wy > n.y + n.r && wy < n.y + n.r + 46) return i;   // title/sub band
    }
    return -1;
  };

  // Frame ALL nodes within the viewport (with margin for titles) so nothing is ever
  // clipped at a corner — works for 1 node or 100. Re-runs on resize until the user
  // takes over with a pan/zoom.
  function fit() {
    if (!nodes.length || !W || !H) { panX = panY = 0; scale = 1; return; }
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const n of nodes) {
      minx = Math.min(minx, n.x - n.r); maxx = Math.max(maxx, n.x + n.r);
      miny = Math.min(miny, n.y - n.r); maxy = Math.max(maxy, n.y + n.r + 54);   // headroom for the title + sub under each node
    }
    const bw = Math.max(maxx - minx, 1), bh = Math.max(maxy - miny, 1), m = 170;
    // Cap zoom-in at 1.4 (few nodes stay big & crisp, not ballooned) and never below 0.3.
    scale = Math.max(0.3, Math.min((W - m) / bw, (H - m) / bh, 1.4));
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    panX = -cx * scale; panY = -cy * scale;                                       // centre the cluster in the viewport
  }

  let _didFit = false;
  function resize() {
    const r = canvas.getBoundingClientRect();
    W = Math.round(r.width); H = Math.round(r.height); dpr = Math.min(devicePixelRatio || 1, 2.5);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!userMoved) { fit(); _didFit = W > 0 && H > 0; }
  }
  addEventListener('resize', resize); resize(); fit();
  // Layout may not be settled at construction (fonts/flex) → re-fit once on the next
  // frame so the cluster is correctly centred, never stuck cut-off in a corner.
  requestAnimationFrame(() => { resize(); });

  // ── Pointer handling: drag node / pan / click ──
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerid ?? e.pointerId);
    const w = toWorld(e.offsetX, e.offsetY);
    const idx = hit(w.x, w.y);
    drag = { idx, startX: e.offsetX, startY: e.offsetY, lx: e.offsetX, ly: e.offsetY, moved: false };
  });
  canvas.addEventListener('pointermove', e => {
    const w = toWorld(e.offsetX, e.offsetY);
    hover = hit(w.x, w.y);
    canvas.style.cursor = hover >= 0 ? 'pointer' : (drag ? 'grabbing' : 'grab');
    if (!drag) return;
    // Only treat it as a DRAG past a 5px deadzone — sub-pixel jitter during a tap must
    // not move the node/pan, or the click-to-open would never register.
    if (!drag.moved && Math.hypot(e.offsetX - drag.startX, e.offsetY - drag.startY) > 5) drag.moved = true;
    const dx = e.offsetX - drag.lx, dy = e.offsetY - drag.ly;
    drag.lx = e.offsetX; drag.ly = e.offsetY;
    if (!drag.moved) return;                              // still within the tap deadzone → ignore
    if (drag.idx >= 0) { nodes[drag.idx].x += dx / scale; nodes[drag.idx].y += dy / scale; }
    else { panX += dx; panY += dy; userMoved = true; }   // pan the whole graph freely across the screen
  });
  // Wheel / trackpad zoom, anchored on the cursor.
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const ns = Math.max(0.2, Math.min(3, scale * Math.exp(-e.deltaY * 0.0012)));
    const wx = (e.offsetX - W / 2 - panX) / scale, wy = (e.offsetY - H / 2 - panY) / scale;
    panX = e.offsetX - W / 2 - wx * ns; panY = e.offsetY - H / 2 - wy * ns;
    scale = ns; userMoved = true;
  }, { passive: false });
  let _opening = false;                                  // guard so a tap can't double-navigate
  function doOpen(it) { if (_opening) return; _opening = true; onOpen(it); }
  function tapOpen(e) {
    const w = toWorld(e.offsetX, e.offsetY);
    const idx = hit(w.x, w.y);
    if (idx >= 0) doOpen(nodes[idx].it);
  }
  function endDrag(e) {
    // A tap (never crossed the drag deadzone) → open the node under the release point.
    if (drag && !drag.moved) tapOpen(e);
    drag = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => { drag = null; });
  // Fallback for environments where pointerup lands oddly: a plain click still opens.
  canvas.addEventListener('click', e => { if (!(drag && drag.moved)) tapOpen(e); });

  // ── Render loop ──
  let t = 0;
  function frame() {
    t += 0.016;
    // Safety net: if the first fit ran before the canvas had real dimensions, fit now.
    if (!_didFit && !userMoved && W > 0 && H > 0) { fit(); _didFit = true; }
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2 + panX, H / 2 + panY);
    ctx.scale(scale, scale);

    // edges
    ctx.lineWidth = 1;
    edges.forEach(([i, j]) => {
      const a = nodes[i], b = nodes[j];
      const lit = hover === i || hover === j;
      ctx.strokeStyle = `rgba(${lit ? GREEN : DIM},${lit ? 0.5 : 0.22})`;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });

    // nodes
    nodes.forEach((n, i) => {
      const lit = hover === i;
      const bob = Math.sin(t * 0.9 + n.phase) * 2;
      const x = n.x, y = n.y + bob;
      // glow ring
      ctx.beginPath(); ctx.arc(x, y, n.r, 0, 6.2832);
      ctx.shadowColor = `rgba(${GREEN},${lit ? 0.9 : 0.45})`; ctx.shadowBlur = lit ? 26 : 14;
      ctx.fillStyle = '#061410'; ctx.fill(); ctx.shadowBlur = 0;
      // thumbnail clipped to circle, or generated fill
      ctx.save(); ctx.beginPath(); ctx.arc(x, y, n.r - 3, 0, 6.2832); ctx.clip();
      if (n.imgReady && n.img) {
        const s = Math.max((n.r * 2) / n.img.width, (n.r * 2) / n.img.height);
        const iw = n.img.width * s, ih = n.img.height * s;
        ctx.drawImage(n.img, x - iw / 2, y - ih / 2, iw, ih);
      } else {
        const g = ctx.createLinearGradient(x - n.r, y - n.r, x + n.r, y + n.r);
        g.addColorStop(0, '#0c2a1d'); g.addColorStop(1, '#04140d');
        ctx.fillStyle = g; ctx.fillRect(x - n.r, y - n.r, n.r * 2, n.r * 2);
        ctx.fillStyle = `rgba(${GREEN},0.85)`; ctx.font = '600 26px "Space Grotesk",system-ui,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText((n.it.title || '?').trim().charAt(0).toUpperCase(), x, y);
      }
      ctx.restore();
      // rim
      ctx.beginPath(); ctx.arc(x, y, n.r - 3, 0, 6.2832);
      ctx.strokeStyle = `rgba(${lit ? GREEN : CYAN},${lit ? 0.95 : 0.6})`; ctx.lineWidth = lit ? 2.6 : 1.6; ctx.stroke();
      // ── Title beneath — drawn larger, with a dark outline so it's legible on ANY
      //    background (bright sky thumbs or dark void). ──
      const title = clip(n.it.title || 'untitled', 22);
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.font = '600 16px "Space Grotesk",system-ui,sans-serif';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(2,7,5,0.92)'; ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 4;
      ctx.strokeText(title, x, y + n.r + 9);                              // dark halo
      ctx.shadowBlur = 0;
      ctx.fillStyle = lit ? `rgb(${GREEN.split(',').join(',')})` : '#eafff1';
      ctx.fillText(title, x, y + n.r + 9);
      if (n.it.sub) {
        ctx.font = '500 12px "Space Grotesk",system-ui,sans-serif';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(2,7,5,0.9)';
        ctx.strokeText(clip(n.it.sub, 30), x, y + n.r + 30);
        ctx.fillStyle = 'rgba(150,180,165,.95)';
        ctx.fillText(clip(n.it.sub, 30), x, y + n.r + 30);
      }
    });

    ctx.restore();
    requestAnimationFrame(frame);
  }
  frame();

  // Allow late-arriving thumbnails (lazy fetch) to attach by id.
  return {
    setThumb(id, src) { const n = nodes.find(n => n.it.id === id); if (n && src) loadOne(n, src); },
    resetView() { userMoved = false; fit(); },
  };
}

function loadThumbs(nodes) { nodes.forEach(n => { if (n.it.thumb) loadOne(n, n.it.thumb); }); }
function loadOne(n, src) { const im = new Image(); im.onload = () => { n.img = im; n.imgReady = true; }; im.src = src; }
function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

export default mountWorldGraph;
