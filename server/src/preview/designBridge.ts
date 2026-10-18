/**
 * Design Mode bridge. The preview proxy injects this script into the HTML of a
 * preview that was opened in design mode; it runs in the preview's own origin —
 * the only place with DOM access to the dev server's page. It highlights what
 * the pointer is over and, on a tap, sends the element to the AgentDeck app via
 * `postMessage`: a CSS selector, the outer HTML, and the computed styles that
 * differ from a fresh element of the same tag (what a devtools inspector shows).
 *
 * Host → preview: `{ source: 'agentdeck-design-host', type: 'set', on: boolean }`
 * Preview → host: `{ source: 'agentdeck-design', type: 'pick' | 'off', pick? }`
 */
export const DESIGN_BRIDGE_PATH = '/__agentdeck_design.js';
export const DESIGN_COOKIE = 'agentdeck_design';
/** Marker the script tag is injected with — also the test's handle. */
export const DESIGN_BRIDGE_TAG = `<script src="${DESIGN_BRIDGE_PATH}"></script>`;

const BRIDGE = String.raw`(function () {
  if (window.__agentdeckDesign) return;
  window.__agentdeckDesign = true;
  var SELF = 'agentdeck-design';
  var HOST = 'agentdeck-design-host';
  var MAX_HTML = 4000;
  var MAX_TEXT = 300;
  var PROPS = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height',
    'min-width', 'max-width', 'min-height', 'max-height', 'margin', 'padding',
    'color', 'background-color', 'background-image', 'border', 'border-radius',
    'box-shadow', 'opacity', 'font-family', 'font-size', 'font-weight', 'line-height',
    'letter-spacing', 'text-align', 'text-transform', 'text-decoration', 'flex-direction',
    'justify-content', 'align-items', 'gap', 'grid-template-columns', 'grid-template-rows',
    'overflow', 'z-index', 'transform', 'transition'
  ];
  var on = false;
  var hovered = null;
  var frame = document.createElement('div');
  frame.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #7C5CFF;background:rgba(124,92,255,0.16);border-radius:3px;display:none';
  var badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#7C5CFF;color:#fff;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;padding:1px 6px;border-radius:5px;display:none;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

  function mount() {
    var root = document.documentElement;
    if (!root) return;
    if (frame.parentNode !== root) root.appendChild(frame);
    if (badge.parentNode !== root) root.appendChild(badge);
  }

  function show(el) {
    var r = el.getBoundingClientRect();
    frame.style.display = 'block';
    frame.style.left = r.left + 'px';
    frame.style.top = r.top + 'px';
    frame.style.width = r.width + 'px';
    frame.style.height = r.height + 'px';
    badge.style.display = 'block';
    badge.textContent = describe(el);
    badge.style.left = Math.max(4, r.left) + 'px';
    badge.style.top = (r.top > 22 ? r.top - 20 : r.bottom + 2) + 'px';
  }

  function hide() {
    frame.style.display = 'none';
    badge.style.display = 'none';
    hovered = null;
  }

  function describe(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    var r = el.getBoundingClientRect();
    return s + '  ' + Math.round(r.width) + 'x' + Math.round(r.height);
  }

  function escape(value) {
    return String(value).replace(/([^\w-]|^(\d))/g, '\\$1');
  }

  function selectorOf(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      var part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(part + '#' + escape(node.id)); break; }
      var cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) part += '.' + cls.map(escape).join('.');
      var parent = node.parentElement;
      if (parent) {
        var same = [];
        for (var i = 0; i < parent.children.length; i++) if (parent.children[i].tagName === node.tagName) same.push(parent.children[i]);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function stylesOf(el) {
    var cs = window.getComputedStyle(el);
    var probe = document.createElement(el.tagName);
    probe.setAttribute('style', 'position:absolute!important;visibility:hidden!important;pointer-events:none!important;top:-9999px!important;left:-9999px!important');
    document.documentElement.appendChild(probe);
    var base = window.getComputedStyle(probe);
    var out = {};
    for (var i = 0; i < PROPS.length; i++) {
      var value = cs.getPropertyValue(PROPS[i]);
      if (value && value !== base.getPropertyValue(PROPS[i])) out[PROPS[i]] = value;
    }
    probe.parentNode.removeChild(probe);
    return out;
  }

  function pick(el) {
    var html = el.outerHTML || '';
    html = html.replace(/\n\s*/g, '\n').trim();
    return {
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: (el.getAttribute('class') || '').trim() || undefined,
      text: (el.textContent || '').trim().slice(0, MAX_TEXT) || undefined,
      html: html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html,
      truncated: html.length > MAX_HTML,
      styles: stylesOf(el),
      rect: (function () { var r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })(),
      parent: el.parentElement ? describe(el.parentElement) : undefined,
      url: location.pathname + location.search,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scale: window.devicePixelRatio || 1
    };
  }

  function post(message) {
    try { window.parent.postMessage(message, '*'); } catch (e) {}
  }

  function setOn(next) {
    on = !!next;
    mount();
    if (!on) hide();
  }

  window.addEventListener('message', function (ev) {
    var data = ev.data;
    if (!data || data.source !== HOST) return;
    if (data.type === 'set') setOn(data.on);
  }, false);

  document.addEventListener('pointermove', function (ev) {
    if (!on) return;
    var el = ev.target;
    if (!el || el.nodeType !== 1 || el === frame || el === badge) return;
    if (el === hovered) return;
    hovered = el;
    show(el);
  }, true);

  document.addEventListener('click', function (ev) {
    if (!on) return;
    var el = ev.target;
    if (!el || el.nodeType !== 1) return;
    ev.preventDefault();
    ev.stopPropagation();
    var payload;
    try { payload = pick(el); } catch (e) { payload = null; }
    if (payload) post({ source: SELF, type: 'pick', pick: payload });
  }, true);

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && on) { setOn(false); post({ source: SELF, type: 'off' }); }
  }, true);

  // The dev server may replace the body on HMR — keep the overlay mounted.
  var observer = new MutationObserver(function () { if (on) mount(); });
  observer.observe(document.documentElement, { childList: true, subtree: false });

  post({ source: SELF, type: 'ready' });
})();`;

export function designBridgeScript(): string {
  return BRIDGE;
}

/** Inserts the bridge tag before the closing `</body>`; appends it when there is none. */
export function injectBridge(html: string): string {
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx < 0) return html + DESIGN_BRIDGE_TAG;
  return html.slice(0, idx) + DESIGN_BRIDGE_TAG + html.slice(idx);
}
