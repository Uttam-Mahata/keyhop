// Keyhop background: everything that needs browser.* privileges.
// The content script only sends small, validated messages; it never gets tab access itself.
'use strict';

const OPENABLE = new Set(['http:', 'https:', 'file:', 'ftp:']);

function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return OPENABLE.has(u.protocol) ? u.href : null;
  } catch (_) {
    return null;
  }
}

// "example.com", "localhost:3000", "10.0.0.1/path" -> URL; anything with spaces -> search.
function looksLikeUrl(text) {
  if (/\s/.test(text)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return true;
  if (/^localhost(:\d+)?(\/|$)/i.test(text)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text)) return true;
  return /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/|$|\?|#)/i.test(text);
}

async function switchTab(sender, delta) {
  const tabs = await browser.tabs.query({ currentWindow: true });
  tabs.sort((a, b) => a.index - b.index);
  const cur = tabs.findIndex(t => t.id === sender.tab.id);
  if (cur < 0 || tabs.length < 2) return;
  const next = tabs[(cur + delta + tabs.length) % tabs.length];
  await browser.tabs.update(next.id, { active: true });
}

async function restoreTab() {
  const closed = await browser.sessions.getRecentlyClosed({ maxResults: 1 });
  const entry = closed[0];
  if (!entry) return;
  const id = entry.tab ? entry.tab.sessionId : entry.window.sessionId;
  await browser.sessions.restore(id);
}

async function openUrl(sender, { url, newTab, active }) {
  const href = safeUrl(url);
  if (!href) return;
  if (newTab) {
    await browser.tabs.create({
      url: href,
      active: !!active,
      openerTabId: sender.tab.id,
      index: sender.tab.index + 1,
    });
  } else {
    await browser.tabs.update(sender.tab.id, { url: href });
  }
}

async function omni(sender, { query, newTab }) {
  const text = String(query || '').trim();
  if (!text) return;
  if (looksLikeUrl(text)) {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text;
    return openUrl(sender, { url: withScheme, newTab, active: true });
  }
  // Uses the engine chosen in Firefox settings.
  await browser.search.search({
    query: text,
    ...(newTab ? { disposition: 'NEW_TAB' } : { tabId: sender.tab.id }),
  });
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab || !msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'tab':        return switchTab(sender, msg.delta === -1 ? -1 : 1);
    case 'closeTab':   return browser.tabs.remove(sender.tab.id);
    case 'restoreTab': return restoreTab();
    case 'newTab':     return browser.tabs.create({ active: true });
    case 'openUrl':    return openUrl(sender, msg);
    case 'omni':       return omni(sender, msg);
    default:           return;
  }
});
