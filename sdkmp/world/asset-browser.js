/**
 * hopeOS SDK — Asset Browser
 * ═══════════════════════════════════════════════════════════════
 * A Sketchfab-style browse gallery in the hopeOS neon-green scheme. Renders model
 * cards (thumbnail + name + author) into a grid and pages through results with a
 * "load more" tile (cursor pagination) so the user can browse broadly — not just
 * the first handful.
 *
 *   const b = createBrowser(gridEl, {
 *     onPick:   (model, query) => { ... resolveGLB(model.uid) ... },
 *     onStatus: (text) => hintEl.textContent = text,
 *   });
 *   b.search('roman temple interior');   // returns a Promise<number> (count so far)
 */
import { searchModels } from './sketchfab.js';

export function createBrowser(grid, opts = {}) {
  const onPick = opts.onPick || (() => {});
  const onStatus = opts.onStatus || (() => {});
  const pageCount = opts.count || 24;
  let query = '', cursor = null, loading = false, moreBtn = null;

  function card(h) {
    const c = document.createElement('button');
    c.className = 'mcard';
    c.style.cssText = 'position:relative;display:flex;flex-direction:column;padding:0;border:1px solid rgba(73,231,134,.2);background:#07120d;border-radius:10px;overflow:hidden;cursor:pointer;font-family:inherit;text-align:left;transition:border .15s,box-shadow .15s,transform .15s';
    c.onmouseenter = () => { c.style.borderColor = '#5dff9b'; c.style.boxShadow = '0 0 18px rgba(93,255,155,.35)'; c.style.transform = 'translateY(-2px)'; };
    c.onmouseleave = () => { c.style.borderColor = 'rgba(73,231,134,.2)'; c.style.boxShadow = ''; c.style.transform = ''; };
    const im = document.createElement('img'); im.src = h.thumb; im.loading = 'lazy';
    im.style.cssText = 'width:100%;aspect-ratio:1;object-fit:cover;display:block;background:#04140d';
    const lab = document.createElement('div');
    lab.style.cssText = 'padding:6px 8px;font-size:11px;color:#d7ecdd;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    lab.textContent = h.name || 'untitled';
    if (h.author) { const a = document.createElement('div'); a.style.cssText = 'padding:0 8px 7px;font-size:9px;color:#5d7468;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'; a.textContent = 'by ' + h.author; c.appendChild(im); c.appendChild(lab); c.appendChild(a); }
    else { c.appendChild(im); c.appendChild(lab); }
    c.addEventListener('click', () => onPick(h, query));
    return c;
  }

  function clearMore() { if (moreBtn) { moreBtn.remove(); moreBtn = null; } }
  function addMore() {
    clearMore();
    if (!cursor) return;
    moreBtn = document.createElement('button');
    moreBtn.style.cssText = 'grid-column:1/-1;padding:11px;border:1px dashed rgba(73,231,134,.4);background:rgba(73,231,134,.06);color:#5dff9b;border-radius:10px;cursor:pointer;font-family:inherit;font-size:12px;letter-spacing:1px;transition:.15s';
    moreBtn.onmouseenter = () => moreBtn.style.background = 'rgba(73,231,134,.14)';
    moreBtn.onmouseleave = () => moreBtn.style.background = 'rgba(73,231,134,.06)';
    moreBtn.textContent = '＋ load more';
    moreBtn.addEventListener('click', () => load(false));
    grid.appendChild(moreBtn);
  }

  async function load(reset) {
    if (loading || !query) return grid.querySelectorAll('.mcard').length;
    loading = true;
    if (reset) { grid.innerHTML = ''; cursor = null; }
    clearMore();
    onStatus(reset ? 'searching “' + query + '”…' : 'loading more…');
    try {
      const { results, next } = await searchModels(query, { count: pageCount, cursor });
      cursor = next;
      results.forEach(h => grid.appendChild(card(h)));
      addMore();
      const total = grid.querySelectorAll('.mcard').length;
      onStatus(total
        ? total + ' result' + (total === 1 ? '' : 's') + ' for “' + query + '”' + (cursor ? ' · load more for thousands more' : '')
        : 'no downloadable models for “' + query + '” — try other words, or paste a .glb URL / upload one');
      return total;
    } catch (e) { onStatus('search failed: ' + e.message); return 0; }
    finally { loading = false; }
  }

  return {
    search(q) { query = (q || '').trim(); return query ? load(true) : Promise.resolve(0); },
    loadMore() { return load(false); },
    clear() { grid.innerHTML = ''; cursor = null; query = ''; },
    grid,
  };
}

export default createBrowser;
