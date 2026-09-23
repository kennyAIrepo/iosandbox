/**
 * hopeOS SDK — Universal Panel Toggle (pin / unpin floating panels)
 * ═══════════════════════════════════════════════════════════════
 * THE DEFAULT for every hopeOS page. Drop this one line into any page
 * (classic, deferred — no import map, no module graph needed):
 *
 *   <script src="./sdk/ui/panel-toggle.js" defer></script>
 *
 * It adds ONE always-visible top-right button that hides/shows every
 * floating panel on the page, so there's always a way to reclaim a full
 * undisturbed view — essential on small phone screens where a control
 * panel can cover the whole frame.
 *
 * Panels are matched by a sensible default selector. Override per page by
 * setting a global BEFORE this script loads:
 *   <script>window.PANEL_TOGGLE = { selector: '.myPanel, #foo' };</script>
 *
 * SAFE TO INCLUDE ANYWHERE: it is idempotent and self-suppresses if the
 * page already ships its own toggle (#panelToggle / #ptgl) or has no
 * panels — so it can be dropped into every page unconditionally.
 */
(function () {
  var cfg = window.PANEL_TOGGLE || {};
  var SELECTOR = cfg.selector || '.panel, .menu-panel, [data-panel], #hud, #hudL, #hudR, #panel';

  function init() {
    // don't double up: skip if this or a page-local toggle already exists
    if (document.getElementById('hopeosPanelToggle') ||
        document.getElementById('panelToggle') ||
        document.getElementById('ptgl')) return;
    if (!document.querySelector(SELECTOR)) return;   // nothing to toggle → no button

    var css = document.createElement('style');
    css.textContent =
      '#hopeosPanelToggle{position:fixed;top:12px;right:12px;z-index:9998;width:44px;height:44px;' +
      'padding:0;border-radius:11px;background:#1b2740d9;border:1px solid #4a6aa0;color:#dfe6f0;' +
      "font:19px/42px ui-monospace,Menlo,Consolas,monospace;text-align:center;cursor:pointer;" +
      'backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px)}' +
      '.hopeos-panel-hidden{display:none !important}';
    document.head.appendChild(css);

    var btn = document.createElement('button');
    btn.id = 'hopeosPanelToggle';
    btn.type = 'button';
    btn.textContent = '✕';                       // ✕
    btn.title = 'hide panels (full view)';
    btn.setAttribute('aria-label', 'toggle panels');
    document.body.appendChild(btn);

    var hidden = false;
    btn.addEventListener('click', function () {
      hidden = !hidden;
      var panels = document.querySelectorAll(SELECTOR);
      for (var i = 0; i < panels.length; i++) {
        if (panels[i] === btn) continue;
        panels[i].classList.toggle('hopeos-panel-hidden', hidden);
      }
      btn.textContent = hidden ? '☰' : '✕'; // ☰ / ✕
      btn.title = hidden ? 'show panels' : 'hide panels (full view)';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
