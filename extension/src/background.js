/* DriveRelay browser extension — background (Chrome service worker / Firefox event page). */
'use strict';

const ext = globalThis.browser || globalThis.chrome;
const DEFAULTS = { port: 6801, enabled: true, skipDomains: '' };
const FILE_RE =
  /\.(zip|rar|7z|tar|gz|bz2|xz|iso|img|exe|msi|dmg|pkg|apk|deb|rpm|appimage|mp4|mkv|avi|mov|wmv|flv|webm|m4v|mp3|flac|wav|aac|ogg|m4a|pdf|epub|docx?|xlsx?|pptx?|psd|ai|torrent|bin|jar)(\?|#|$)/i;

let status = null; // last /api/ping response (null = app not reachable)
let statusAt = 0;
const passThrough = new Set(); // URLs the browser must download itself (fallback)

async function cfg() {
  const v = await ext.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...v };
}

async function bridge(path, body) {
  const { port } = await cfg();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', 'X-DriveRelay': '1' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(4000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function ping(force = false) {
  if (!force && Date.now() - statusAt < 15000) return status;
  try {
    status = await bridge('/api/ping');
  } catch {
    status = null;
  }
  statusAt = Date.now();
  await updateBadge();
  return status;
}

async function updateBadge() {
  const { enabled } = await cfg();
  const action = ext.action || ext.browserAction;
  if (!action) return;
  if (!status) {
    action.setBadgeText({ text: 'off' });
    action.setBadgeBackgroundColor({ color: '#6b7280' });
    action.setTitle({ title: 'DriveRelay: app is not running' });
  } else if (!enabled || !status.capture) {
    action.setBadgeText({ text: '' });
    action.setTitle({ title: 'DriveRelay: connected (capture disabled)' });
  } else {
    action.setBadgeText({ text: '' });
    action.setTitle({ title: 'DriveRelay: connected — downloads are captured' });
  }
}

async function cookiesFor(url) {
  try {
    if (!ext.cookies) return '';
    const list = await ext.cookies.getAll({ url });
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

function baseName(p) {
  return String(p || '')
    .split(/[\\/]/)
    .pop();
}

async function sendDownload(url, extra = {}) {
  const cookies = await cookiesFor(url);
  return bridge('/api/download', {
    url,
    cookies,
    userAgent: navigator.userAgent,
    ...extra
  });
}

function notify(message) {
  if (!ext.notifications) return;
  ext.notifications.create({
    type: 'basic',
    iconUrl: ext.runtime.getURL('icons/icon128.png'),
    title: 'DriveRelay',
    message
  });
}

/* ------------------------- capture browser downloads ------------------------- */

ext.downloads.onCreated.addListener(async (item) => {
  try {
    const url = item.finalUrl || item.url;
    if (!/^https?:/i.test(url)) return; // blob:/data: cannot be re-downloaded
    if (passThrough.delete(url) || passThrough.delete(item.url)) return;
    if (item.state && item.state !== 'in_progress') return;
    const c = await cfg();
    if (!c.enabled) return;
    const host = new URL(url).hostname;
    const skip = c.skipDomains
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (skip.some((d) => host === d || host.endsWith('.' + d))) return;
    const st = await ping();
    if (!st || !st.capture) return;
    const size = item.totalBytes || item.fileSize || 0;
    if (size > 0 && st.minSizeKB && size < st.minSizeKB * 1024) return;
    if (st.extensions) {
      const allowed = st.extensions
        .split(/[\s,]+/)
        .map((e) => e.replace(/^\./, '').toLowerCase())
        .filter(Boolean);
      const name = baseName(item.filename) || baseName(new URL(url).pathname);
      const e = (name.split('.').pop() || '').toLowerCase();
      if (allowed.length && !allowed.includes(e)) return;
    }

    await ext.downloads.cancel(item.id).catch(() => {});
    await ext.downloads.erase({ id: item.id }).catch(() => {});
    try {
      await sendDownload(url, {
        filename: baseName(item.filename) || undefined,
        referrer: item.referrer || undefined,
        fileSize: size || undefined,
        mime: item.mime || undefined
      });
    } catch (e) {
      // App refused / crashed: give the download back to the browser.
      passThrough.add(url);
      ext.downloads.download({ url });
    }
  } catch (e) {
    console.warn('DriveRelay capture failed', e);
  }
});

/* -------------------------------- context menus ------------------------------ */

function createMenus() {
  ext.contextMenus.removeAll(() => {
    ext.contextMenus.create({ id: 'dr-link', title: 'Download with DriveRelay', contexts: ['link'] });
    ext.contextMenus.create({ id: 'dr-media', title: 'Download media with DriveRelay', contexts: ['image', 'video', 'audio'] });
    ext.contextMenus.create({ id: 'dr-relay-link', title: 'Send link to Drive Relay (download → upload)', contexts: ['link'] });
    ext.contextMenus.create({ id: 'dr-relay-page', title: 'Relay this Google Drive page', contexts: ['page'], documentUrlPatterns: ['https://drive.google.com/*', 'https://docs.google.com/*'] });
    ext.contextMenus.create({ id: 'dr-all', title: 'Download all file links on this page', contexts: ['page'] });
  });
}

ext.runtime.onInstalled.addListener(() => {
  createMenus();
  ping(true);
});
ext.runtime.onStartup?.addListener(() => ping(true));

async function collectLinks(tabId) {
  const [res] = await ext.scripting.executeScript({
    target: { tabId },
    func: () => [...document.querySelectorAll('a[href]')].map((a) => a.href)
  });
  const links = [...new Set(res?.result || [])].filter((u) => /^https?:/i.test(u) && FILE_RE.test(u));
  return links;
}

ext.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'dr-link') {
      await sendDownload(info.linkUrl, { referrer: info.pageUrl });
    } else if (info.menuItemId === 'dr-media') {
      await sendDownload(info.srcUrl, { referrer: info.pageUrl });
    } else if (info.menuItemId === 'dr-relay-link') {
      await bridge('/api/relay', { source: info.linkUrl });
    } else if (info.menuItemId === 'dr-relay-page') {
      await bridge('/api/relay', { source: info.pageUrl });
    } else if (info.menuItemId === 'dr-all') {
      const links = await collectLinks(tab.id);
      if (!links.length) return notify('No downloadable file links found on this page.');
      const cookies = await cookiesFor(links[0]);
      await bridge('/api/downloads', { items: links.map((url) => ({ url })), referrer: info.pageUrl, cookies, userAgent: navigator.userAgent });
    }
  } catch (e) {
    notify(`Could not reach the DriveRelay app. Is it running? (${e.message})`);
  }
});

/* ------------------------------ popup messaging ------------------------------ */

ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'status':
        return { status: await ping(!!msg.force), cfg: await cfg() };
      case 'setEnabled':
        await ext.storage.local.set({ enabled: !!msg.enabled });
        await updateBadge();
        return { ok: true };
      case 'download':
        return sendDownload(msg.url, { referrer: msg.referrer });
      case 'relay':
        return bridge('/api/relay', { source: msg.url });
      case 'show':
        return bridge('/api/show', {});
      case 'grabAll': {
        const links = await collectLinks(msg.tabId);
        if (!links.length) return { ok: false, error: 'No downloadable file links found on this page.' };
        await bridge('/api/downloads', { items: links.map((url) => ({ url })), referrer: msg.pageUrl, cookies: await cookiesFor(links[0]), userAgent: navigator.userAgent });
        return { ok: true, count: links.length };
      }
      default:
        return { ok: false, error: 'unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
  return true; // async response
});

ext.storage.onChanged.addListener(() => {
  statusAt = 0;
  ping(true);
});

// Keep the badge fresh.
if (ext.alarms) {
  ext.alarms.create('dr-ping', { periodInMinutes: 1 });
  ext.alarms.onAlarm.addListener((a) => a.name === 'dr-ping' && ping(true));
}
ping(true);
