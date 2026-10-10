// Keyhop content script: modal key handling, link hints, scrolling, command bar.
// Modes: normal | insert | hints | omni | help
(() => {
  'use strict';
  if (window.top !== window) return;

  const DEFAULTS = {
    excluded: [],
    hintChars: 'asdfghjklqwertyuiopzxcvbnm',
    newTabActive: false,
  };
  let opts = { ...DEFAULTS };
  let excluded = false;

  let mode = 'normal';
  let pending = '';
  let pendingTimer = 0;
  let count = '';
  const swallowed = new Set(); // e.code values whose keypress/keyup must not reach the page

  // ------------------------------------------------------------ options
  function matchesExcluded() {
    const target = location.hostname + location.pathname;
    return opts.excluded.some(p => {
      p = String(p).trim();
      if (!p) return false;
      const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
      return re.test(target) || re.test(location.href);
    });
  }

  function applyOptions(stored) {
    opts = { ...DEFAULTS, ...stored };
    const uniq = [...new Set(String(opts.hintChars).toLowerCase().replace(/[^a-z0-9]/g, ''))];
    opts.hintChars = uniq.length >= 4 ? uniq.join('') : DEFAULTS.hintChars;
    excluded = matchesExcluded();
    if (excluded && mode !== 'normal') setMode('normal');
  }

  browser.storage.local.get(DEFAULTS).then(applyOptions, () => {});
  browser.storage.onChanged.addListener(() => {
    browser.storage.local.get(DEFAULTS).then(applyOptions, () => {});
  });

  // ------------------------------------------------------------ overlay UI
  let host = null;
  let root = null;

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-monospace, "JetBrainsMono Nerd Font", monospace; }
    .hint {
      position: fixed; z-index: 2147483647; padding: 1px 4px; border-radius: 3px;
      font-size: 12px; font-weight: 700; line-height: 1.25; text-transform: uppercase;
      color: #1b1b1b; background: linear-gradient(#ffe86a, #ffc61a);
      border: 1px solid #b38600; box-shadow: 0 1px 3px rgba(0,0,0,.4); pointer-events: none;
    }
    .hint .typed { color: #b3731a; }
    .toast, .bar, .help {
      position: fixed; z-index: 2147483647; color: #e6e6e6; background: rgba(24,26,32,.96);
      border: 1px solid rgba(255,255,255,.18); border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.45);
    }
    .toast { right: 16px; bottom: 16px; padding: 6px 12px; font-size: 13px; }
    .bar { left: 50%; top: 18%; transform: translateX(-50%); width: min(640px, 90vw); padding: 10px; pointer-events: auto; }
    .bar label { display: block; margin-bottom: 6px; font-size: 12px; opacity: .7; }
    .bar input {
      width: 100%; padding: 8px 10px; font-size: 15px; color: inherit; background: #101216;
      border: 1px solid #3a6ea5; border-radius: 6px; outline: none;
    }
    .help { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(780px, 92vw); max-height: 82vh;
            overflow: auto; padding: 16px 20px; font-size: 13px; line-height: 1.6; pointer-events: auto; }
    .help h2 { margin: 0 0 8px; font-size: 16px; }
    .help h3 { margin: 12px 0 2px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; opacity: .65; }
    .help .row { display: flex; gap: 12px; }
    .help kbd { min-width: 76px; display: inline-block; color: #ffe27a; }
    .help .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 28px; }
    @media (prefers-color-scheme: light) {
      .toast, .bar, .help { color: #1e2a33; background: rgba(250,252,253,.97); border-color: rgba(0,0,0,.18); }
      .bar input { background: #fff; }
      .help kbd { color: #7a5200; }
    }
  `;

  function ui() {
    if (host && host.isConnected) return root;
    host = document.createElement('div');
    host.id = 'keyhop-root';
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.append(style);
    (document.documentElement || document).append(host);
    host.dataset.mode = mode;
    return root;
  }

  function setMode(next) {
    mode = next;
    if (host) host.dataset.mode = next;
  }

  let toastTimer = 0;
  function toast(text, ms = 1600) {
    const r = ui();
    r.querySelectorAll('.toast').forEach(n => n.remove());
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    r.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), ms);
  }

  // ------------------------------------------------------------ helpers
  function deepActive() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  const NON_TEXT_INPUT = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'color', 'range']);
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !NON_TEXT_INPUT.has((el.type || 'text').toLowerCase());
    if (el.isContentEditable) return true;
    const role = el.getAttribute && el.getAttribute('role');
    return role === 'textbox' || role === 'searchbox' || role === 'combobox';
  }

  function isScrollable(el) {
    if (!el || el.nodeType !== 1) return false;
    const s = getComputedStyle(el);
    const oy = s.overflowY, ox = s.overflowX;
    const canY = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1;
    const canX = (ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1;
    return canY || canX;
  }

  // Many apps scroll an inner pane, not the window: find the pane under focus / the viewport centre.
  function getScroller() {
    const docEl = document.scrollingElement || document.documentElement;
    const starts = [deepActive(), document.elementFromPoint(innerWidth / 2, innerHeight / 2)];
    for (let el of starts) {
      for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement || (el.getRootNode && el.getRootNode().host)) {
        if (isScrollable(el)) return el;
      }
    }
    return docEl;
  }

  function scrollBy(dx, dy) {
    const s = getScroller();
    s.scrollBy({ left: dx, top: dy, behavior: 'auto' });
  }

  function pageHeight(s) {
    return s === document.scrollingElement || s === document.documentElement ? innerHeight : s.clientHeight;
  }

  function copyText(text) {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;';
      document.documentElement.append(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) { /* ignore */ }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(fallback);
    } else {
      fallback();
    }
  }

  const send = msg => browser.runtime.sendMessage(msg).catch(() => {});

  // ------------------------------------------------------------ link hints
  const CLICKABLE = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    'label[for]', '[onclick]', '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]',
    '[role=checkbox]', '[role=switch]', '[role=option]', '[contenteditable=""]', '[contenteditable=true]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function visibleRect(el) {
    const rects = el.getClientRects();
    for (const r of rects) {
      if (r.width < 2 || r.height < 2) continue;
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      return r;
    }
    return null;
  }

  function reachable(el, rect) {
    const x = Math.min(Math.max(rect.left + rect.width / 2, 1), innerWidth - 1);
    const y = Math.min(Math.max(rect.top + rect.height / 2, 1), innerHeight - 1);
    let top = document.elementFromPoint(x, y);
    while (top && top.shadowRoot && top.shadowRoot.elementFromPoint) {
      const inner = top.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === top) break;
      top = inner;
    }
    return !!top && (top === el || el.contains(top) || top.contains(el));
  }

  function collectTargets() {
    const found = [];
    const seen = new Set();
    const visit = scope => {
      for (const el of scope.querySelectorAll(CLICKABLE)) {
        if (seen.has(el)) continue;
        seen.add(el);
        const s = getComputedStyle(el);
        if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) continue;
        if (el.disabled) continue;
        const rect = visibleRect(el);
        if (!rect || !reachable(el, rect)) continue;
        found.push({ el, rect });
      }
      for (const n of scope.querySelectorAll('*')) if (n.shadowRoot) visit(n.shadowRoot);
    };
    visit(document);
    // a link wrapping a button etc.: keep the outer one only
    const set = new Set(found.map(f => f.el));
    return found.filter(f => {
      const outer = f.el.parentElement && f.el.parentElement.closest('a[href],button');
      return !(outer && set.has(outer));
    });
  }

  // Prefix-free labels: shortest first, e.g. 26 chars -> a..z, then aa, ab, ...
  function genLabels(n, chars) {
    const q = [''];
    while (q.length < Math.max(n, 2)) {
      const h = q.shift();
      for (const c of chars) q.push(h + c);
    }
    return q.slice(0, n);
  }

  let hintState = null; // { items: [{el, label, node}], typed, how }

  function showHints(how) {
    const targets = collectTargets();
    if (!targets.length) { toast('No links on screen'); return; }
    const r = ui();
    const labels = genLabels(targets.length, opts.hintChars);
    const items = targets.map((t, i) => {
      const node = document.createElement('div');
      node.className = 'hint';
      node.textContent = labels[i];
      node.style.left = Math.max(0, Math.min(t.rect.left, innerWidth - 40)) + 'px';
      node.style.top = Math.max(0, Math.min(t.rect.top, innerHeight - 20)) + 'px';
      r.append(node);
      return { el: t.el, label: labels[i], node };
    });
    hintState = { items, typed: '', how };
    host.dataset.count = String(items.length);
    setMode('hints');
  }

  function clearHints() {
    if (root) root.querySelectorAll('.hint').forEach(n => n.remove());
    hintState = null;
    if (host) host.dataset.count = '0';
    if (mode === 'hints') setMode('normal');
  }

  function renderTyped() {
    for (const it of hintState.items) {
      const ok = it.label.startsWith(hintState.typed);
      it.node.style.display = ok ? '' : 'none';
      if (ok) {
        it.node.textContent = '';
        if (hintState.typed) {
          const t = document.createElement('span');
          t.className = 'typed';
          t.textContent = hintState.typed;
          it.node.append(t);
        }
        it.node.append(it.label.slice(hintState.typed.length));
      }
    }
  }

  function hintHref(el) {
    const a = el.closest ? el.closest('a[href]') : null;
    if (!a) return null;
    const href = a.href;
    if (!href || /^javascript:/i.test(href)) return null;
    return href;
  }

  function activate(item, how) {
    const el = item.el;
    clearHints();
    if (how === 'copy') {
      const href = hintHref(el);
      if (href) { copyText(href); toast('Copied link'); } else toast('No link URL');
      return;
    }
    if (how === 'tab') {
      const href = hintHref(el);
      if (href) { send({ type: 'openUrl', url: href, newTab: true, active: opts.newTabActive }); return; }
    }
    if (isEditable(el)) {
      el.focus();
      return;
    }
    el.focus({ preventScroll: true });
    el.click();
  }

  function handleHintKey(e) {
    if (e.key === 'Escape') { clearHints(); return; }
    if (e.key === 'Backspace') {
      hintState.typed = hintState.typed.slice(0, -1);
      renderTyped();
      return;
    }
    const ch = e.key.length === 1 ? e.key.toLowerCase() : '';
    if (!ch || !opts.hintChars.includes(ch)) return;
    const typed = hintState.typed + ch;
    const matches = hintState.items.filter(it => it.label.startsWith(typed));
    if (!matches.length) return; // ignore keys that match nothing
    hintState.typed = typed;
    if (matches.length === 1 && matches[0].label === typed) {
      activate(matches[0], hintState.how);
    } else {
      renderTyped();
    }
  }

  // ------------------------------------------------------------ command bar
  let bar = null; // { input, newTab }

  function openOmni(newTab) {
    const r = ui();
    const wrap = document.createElement('div');
    wrap.className = 'bar';
    const label = document.createElement('label');
    label.textContent = newTab ? 'Open in new tab: URL or search' : 'Open: URL or search';
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    wrap.append(label, input);
    r.append(wrap);
    bar = { wrap, input, newTab };
    setMode('omni');
    input.focus();
  }

  function closeOmni() {
    if (bar) bar.wrap.remove();
    bar = null;
    if (mode === 'omni') setMode('normal');
  }

  function handleOmniKey(e) {
    if (e.key === 'Escape') { closeOmni(); return true; }
    if (e.key === 'Enter') {
      const q = bar.input.value;
      const nt = bar.newTab;
      closeOmni();
      send({ type: 'omni', query: q, newTab: nt });
      return true;
    }
    return false; // let the input handle typing
  }

  // ------------------------------------------------------------ help
  const HELP = [
    ['Scrolling', [['j / k', 'Down / up'], ['h / l', 'Left / right'], ['d / u', 'Half page down / up'],
                    ['gg / G', 'Top / bottom'], ['5j', 'Repeat with a count']]],
    ['Links', [['f', 'Hint: click link'], ['F', 'Hint: open in new tab'], ['yf', 'Hint: copy link'],
               ['gi', 'Focus first text field']]],
    ['Tabs', [['J / K', 'Previous / next tab'], ['t', 'New tab'], ['x', 'Close tab'], ['X', 'Restore closed tab']]],
    ['Navigate', [['o', 'Open URL or search'], ['O', '...in a new tab'], ['H / L', 'Back / forward'],
                  ['r', 'Reload'], ['gu / gU', 'Up one path / to site root'], ['yy', 'Copy page URL']]],
    ['Modes', [['i', 'Insert mode (keys go to page)'], ['Esc', 'Leave mode / blur field'], ['?', 'This help']]],
  ];

  function toggleHelp() {
    const r = ui();
    const existing = r.querySelector('.help');
    if (existing) { existing.remove(); setMode('normal'); return; }
    const box = document.createElement('div');
    box.className = 'help';
    const h = document.createElement('h2');
    h.textContent = 'Keyhop keys';
    box.append(h);
    const cols = document.createElement('div');
    cols.className = 'cols';
    for (const [title, rows] of HELP) {
      const sec = document.createElement('div');
      const h3 = document.createElement('h3');
      h3.textContent = title;
      sec.append(h3);
      for (const [k, d] of rows) {
        const row = document.createElement('div');
        row.className = 'row';
        const kbd = document.createElement('kbd');
        kbd.textContent = k;
        row.append(kbd, document.createTextNode(d));
        sec.append(row);
      }
      cols.append(sec);
    }
    box.append(cols);
    r.append(box);
    setMode('help');
  }

  // ------------------------------------------------------------ commands
  const goUp = root_ => {
    const u = new URL(location.href);
    if (root_) u.pathname = '/';
    else u.pathname = u.pathname.replace(/\/[^/]*\/?$/, '/') || '/';
    u.search = ''; u.hash = '';
    location.assign(u.href);
  };

  const COMMANDS = {
    j: n => scrollBy(0, 80 * n),
    k: n => scrollBy(0, -80 * n),
    h: n => scrollBy(-80 * n, 0),
    l: n => scrollBy(80 * n, 0),
    d: n => { const s = getScroller(); scrollBy(0, (pageHeight(s) / 2) * n); },
    u: n => { const s = getScroller(); scrollBy(0, -(pageHeight(s) / 2) * n); },
    gg: () => getScroller().scrollTo({ top: 0, behavior: 'auto' }),
    G: () => { const s = getScroller(); s.scrollTo({ top: s.scrollHeight, behavior: 'auto' }); },
    H: () => history.back(),
    L: () => history.forward(),
    r: () => location.reload(),
    f: () => showHints('click'),
    F: () => showHints('tab'),
    yf: () => showHints('copy'),
    yy: () => { copyText(location.href); toast('Copied URL'); },
    J: () => send({ type: 'tab', delta: -1 }),
    K: () => send({ type: 'tab', delta: 1 }),
    gT: () => send({ type: 'tab', delta: -1 }),
    gt: () => send({ type: 'tab', delta: 1 }),
    x: () => send({ type: 'closeTab' }),
    X: () => send({ type: 'restoreTab' }),
    t: () => send({ type: 'newTab' }),
    o: () => openOmni(false),
    O: () => openOmni(true),
    i: () => { setMode('insert'); toast('-- INSERT --', 1200); },
    gi: () => {
      const input = [...document.querySelectorAll('input,textarea,[contenteditable=true]')]
        .find(el => isEditable(el) && visibleRect(el));
      if (input) input.focus();
    },
    gu: () => goUp(false),
    gU: () => goUp(true),
    '?': () => toggleHelp(),
  };
  const PREFIXES = new Set(Object.keys(COMMANDS).flatMap(k => k.length > 1 ? [k.slice(0, -1)] : []));

  function resetPending() {
    pending = '';
    count = '';
    clearTimeout(pendingTimer);
  }

  // ------------------------------------------------------------ key handling
  function consume(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    swallowed.add(e.code);
  }

  function onKeyDown(e) {
    if (excluded || !e.isTrusted) return;

    if (mode === 'omni') {
      e.stopPropagation(); // keep typing away from the page's own shortcuts
      if (handleOmniKey(e)) { e.preventDefault(); swallowed.add(e.code); }
      return;
    }
    if (mode === 'hints') {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      handleHintKey(e);
      consume(e);
      return;
    }
    if (mode === 'help') {
      if (e.key === 'Escape' || e.key === '?') { toggleHelp(); consume(e); }
      else if (!(e.ctrlKey || e.altKey || e.metaKey)) consume(e);
      return;
    }
    if (mode === 'insert') {
      if (e.key === 'Escape') { setMode('normal'); consume(e); }
      return;
    }

    // normal mode
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const active = deepActive();
    if (isEditable(active)) {
      if (e.key === 'Escape') { active.blur(); consume(e); }
      return;
    }

    const key = e.key;
    if (key === 'Escape') {
      if (pending || count) { resetPending(); consume(e); }
      return;
    }
    if (key.length > 1 && key !== 'Escape') return; // arrows, F-keys, Tab... belong to the page

    if (/^[0-9]$/.test(key) && !pending && !(key === '0' && count === '')) {
      count += key;
      consume(e);
      return;
    }

    const seq = pending + key;
    if (Object.prototype.hasOwnProperty.call(COMMANDS, seq)) {
      const n = Math.min(parseInt(count || '1', 10), 200);
      resetPending();
      consume(e);
      COMMANDS[seq](n);
      return;
    }
    if (!pending && PREFIXES.has(key)) {
      pending = key;
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(resetPending, 1000);
      consume(e);
      return;
    }
    resetPending(); // unmapped: leave it to the page
  }

  function swallowFollowUp(e) {
    if (excluded) return;
    if (mode === 'omni' || mode === 'hints' || mode === 'help' || swallowed.has(e.code)) {
      e.stopImmediatePropagation();
      if (e.type === 'keyup') swallowed.delete(e.code);
    }
  }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keypress', swallowFollowUp, true);
  window.addEventListener('keyup', swallowFollowUp, true);

  // Hints are placed for the current scroll position; drop them if the page moves or goes away.
  window.addEventListener('scroll', () => { if (mode === 'hints') clearHints(); }, { passive: true, capture: true });
  window.addEventListener('resize', () => { if (mode === 'hints') clearHints(); });
  window.addEventListener('blur', () => { resetPending(); swallowed.clear(); });
})();
