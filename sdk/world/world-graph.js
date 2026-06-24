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
  let W = 0, H = 0, dpr = Math.min(devicePixelRatio || 1, 2);

  // ── Nodes: golden-angle spiral spread so they fill the space evenly ──
  const R = 46;                                   // node radius (px, world space)
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
  const hit = (wx, wy) => { for (let i = nodes.length - 1; i >= 0; i--) { const n = nodes[i]; if ((wx - n.x) ** 2 + (wy - n.y) ** 2 <= (n.r + 6) ** 2) return i; } return -1; };

  // Frame ALL nodes within the viewport (with margin for titles) so nothing is ever
  // clipped at a corner — works for 1 node or 100. Re-runs on resize until the user
  // takes over with a pan/zoom.
  function fit() {
    if (!nodes.length || !W || !H) { panX = panY = 0; scale = 1; return; }
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const n of nodes) {
      minx = Math.min(minx, n.x - n.r); maxx = Math.max(maxx, n.x + n.r);
      miny = Math.min(miny, n.y - n.r); maxy = Math.max(maxy, n.y + n.r + 44);   // headroom for the title under each node
    }
    const bw = Math.max(maxx - minx, 1), bh = Math.max(maxy - miny, 1), m = 150;
    scale = Math.max(0.25, Math.min((W - m) / bw, (H - m) / bh, 1.5));
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    panX = -cx * scale; panY = -cy * scale;
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height; dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!userMoved) fit();
  }
  addEventListener('resize', resize); resize(); fit();

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
    const dx = e.offsetX - drag.lx, dy = e.offsetY - drag.ly;
    drag.lx = e.offsetX; drag.ly = e.offsetY;
    if (Math.abs(e.offsetX - drag.startX) + Math.abs(e.offsetY - drag.startY) > 4) drag.moved = true;
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
  function endDrag(e) {
    if (drag && drag.idx >= 0 && !drag.moved) onOpen(nodes[drag.idx].it);
    drag = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => { drag = null; });

  // ── Render loop ──
  let t = 0;
  function frame() {
    t += 0.016;
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
      ctx.strokeStyle = `rgba(${lit ? GREEN : CYAN},${lit ? 0.95 : 0.55})`; ctx.lineWidth = lit ? 2.4 : 1.4; ctx.stroke();
      // title beneath
      ctx.fillStyle = lit ? `rgba(${GREEN},1)` : 'rgba(215,236,221,.9)';
      ctx.font = (lit ? '600 ' : '500 ') + '13px "Space Grotesk",system-ui,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.shadowColor = `rgba(${GREEN},${lit ? 0.6 : 0})`; ctx.shadowBlur = lit ? 10 : 0;
      ctx.fillText(clip(n.it.title || 'untitled', 22), x, y + n.r + 8);
      ctx.shadowBlur = 0;
      if (n.it.sub) { ctx.fillStyle = 'rgba(93,116,104,.9)'; ctx.font = '400 10px "Space Grotesk",system-ui,sans-serif'; ctx.fillText(clip(n.it.sub, 26), x, y + n.r + 26); }
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
