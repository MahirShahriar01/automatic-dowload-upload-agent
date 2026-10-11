/* global api, icon, hydrateIcons */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  settings: {},
  info: {},
  downloads: new Map(),
  transfers: new Map(),
  details: new Map(), // transferId -> detailed view (expanded)
  expanded: new Set(),
  accounts: [],
  filter: 'all',
  search: '',
  mode: 'relay',
  bridge: {}
};

/* ------------------------------- formatting ------------------------------ */

function bytes(n) {
  if (n == null || n < 0 || !isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : 1)} ${u[i]}`;
}
const rate = (n) => `${bytes(n || 0)}/s`;
function eta(sec) {
  if (sec == null || !isFinite(sec)) return '';
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s left`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s left`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m left`;
}
function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return new Date(ts).toLocaleString();
}

const TYPE_COLORS = {
  zip: '#f59e0b', rar: '#f97316', '7z': '#fb923c', gz: '#eab308', tar: '#eab308',
  mp4: '#ec4899', mkv: '#db2777', avi: '#be185d', mov: '#e11d48', webm: '#f43f5e',
  mp3: '#8b5cf6', flac: '#7c3aed', wav: '#6d28d9',
  pdf: '#ef4444', doc: '#3b82f6', docx: '#3b82f6', xls: '#16a34a', xlsx: '#16a34a', ppt: '#ea580c', pptx: '#ea580c',
  exe: '#0ea5e9', msi: '#0284c7', dmg: '#64748b', pkg: '#475569', apk: '#22c55e', iso: '#14b8a6',
  jpg: '#06b6d4', jpeg: '#06b6d4', png: '#0891b2', gif: '#0e7490', webp: '#0891b2'
};
function ftype(name) {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase().slice(0, 4);
  const known = name && name.includes('.') ? ext : '';
  const color = TYPE_COLORS[known] || '#475569';
  return `<div class="ftype" style="background:${color}">${esc(known || 'file')}</div>`;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}

async function call(channel, ...args) {
  try {
    return await api.invoke(channel, ...args);
  } catch (e) {
    const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    toast(msg, 'err');
    throw new Error(msg);
  }
}

/* ------------------------------- navigation ------------------------------ */

function nav(page) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'extension') refreshBridge();
}
$$('.nav-item').forEach((b) => b.addEventListener('click', () => nav(b.dataset.page)));

/* --------------------------------- menus --------------------------------- */

function openMenu(anchor, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.id = 'ctx-menu';
  for (const it of items) {
    if (!it) continue;
    const b = document.createElement('button');
    b.innerHTML = `${icon(it.icon)}<span>${esc(it.label)}</span>`;
    if (it.danger) b.classList.add('danger');
    b.addEventListener('click', () => {
      closeMenu();
      it.run();
    });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  m.style.left = `${Math.min(window.innerWidth - mw - 8, r.right - mw)}px`;
  m.style.top = `${r.bottom + mh + 8 > window.innerHeight ? r.top - mh - 4 : r.bottom + 4}px`;
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}
function closeMenu() {
  $('#ctx-menu')?.remove();
}

/* ------------------------------- downloads ------------------------------- */

const ACTIVE = new Set(['queued', 'connecting', 'downloading']);

function dlVisible(d) {
  if (state.search && !`${d.filename} ${d.url}`.toLowerCase().includes(state.search)) return false;
  if (state.filter === 'active') return ACTIVE.has(d.status) || d.status === 'paused';
  if (state.filter === 'completed') return d.status === 'completed';
  if (state.filter === 'failed') return d.status === 'error' || d.status === 'canceled';
  return true;
}

function dlSub(d) {
  const parts = [];
  const pct = d.totalBytes > 0 ? Math.floor((d.receivedBytes / d.totalBytes) * 100) : null;
  if (d.status === 'completed') {
    parts.push(`<span class="ok">${bytes(d.totalBytes)}</span>`);
    parts.push(`<span>${esc(d.dir)}</span>`);
  } else {
    parts.push(`<span>${bytes(d.receivedBytes)} / ${d.totalBytes > 0 ? bytes(d.totalBytes) : '?'}${pct != null ? ` · ${pct}%` : ''}</span>`);
    if (d.status === 'downloading') {
      parts.push(`<span>${rate(d.speed)}</span>`);
      if (d.eta) parts.push(`<span>${eta(d.eta)}</span>`);
      if (d.activeConnections) parts.push(`<span>${d.activeConnections} conn</span>`);
      if (!d.resumable && d.receivedBytes > 0) parts.push('<span title="Server does not support resume">no resume</span>');
    }
    if (d.error) parts.push(`<span class="err">${esc(d.error)}</span>`);
  }
  if (d.meta && d.meta.transfer) parts.push(`<span>↳ relay: ${esc(d.meta.transfer)}</span>`);
  return parts.join('');
}

function dlRow(d) {
  const el = document.createElement('div');
  el.className = 'item';
  el.dataset.id = d.id;
  el.innerHTML = `
    <div class="ft"></div>
    <div class="item-main">
      <div class="item-title"></div>
      <div class="item-sub"></div>
      <div class="progress"><div></div></div>
    </div>
    <div class="item-actions">
      <span class="status"></span>
      <button class="icon-btn act-toggle"></button>
      <button class="icon-btn act-folder" title="Show in folder">${icon('folder')}</button>
      <button class="icon-btn act-more" title="More">${icon('more')}</button>
    </div>`;
  el.querySelector('.act-toggle').addEventListener('click', () => {
    const cur = state.downloads.get(d.id);
    if (ACTIVE.has(cur.status)) call('downloads:pause', d.id);
    else if (cur.status === 'completed') call('downloads:open', d.id);
    else call('downloads:resume', d.id);
  });
  el.querySelector('.act-folder').addEventListener('click', () => call('downloads:showInFolder', d.id));
  el.querySelector('.act-more').addEventListener('click', (e) => {
    e.stopPropagation();
    const cur = state.downloads.get(d.id);
    openMenu(e.currentTarget, [
      cur.status === 'completed' && { icon: 'file', label: 'Open file', run: () => call('downloads:open', d.id) },
      { icon: 'link', label: 'Copy link', run: () => call('downloads:copyLink', d.id).then(() => toast('Link copied')) },
      cur.status !== 'completed' && { icon: 'refresh', label: 'Restart from zero', run: () => call('downloads:restart', d.id) },
      { icon: 'x', label: 'Remove from list', run: () => call('downloads:remove', d.id, false) },
      cur.status === 'completed' && { icon: 'trash', label: 'Delete file', danger: true, run: () => confirm(`Delete "${cur.filename}" from disk?`) && call('downloads:remove', d.id, true) }
    ]);
  });
  el.addEventListener('dblclick', () => state.downloads.get(d.id).status === 'completed' && call('downloads:open', d.id));
  return el;
}

function updateDlRow(el, d) {
  const name = d.filename || d.url;
  const ft = el.querySelector('.ft');
  if (ft.dataset.name !== name) {
    ft.innerHTML = ftype(name);
    ft.dataset.name = name;
  }
  el.querySelector('.item-title').textContent = name;
  el.querySelector('.item-title').title = d.savePath || d.url;
  el.querySelector('.item-sub').innerHTML = dlSub(d);
  const st = el.querySelector('.status');
  st.className = `status ${d.status}`;
  st.textContent = d.status;
  const p = el.querySelector('.progress');
  const pct = d.status === 'completed' ? 100 : d.totalBytes > 0 ? (d.receivedBytes / d.totalBytes) * 100 : 0;
  p.className = `progress ${d.status === 'completed' ? 'done' : d.status === 'error' ? 'err' : d.status === 'paused' ? 'paused' : ''} ${
    d.status === 'downloading' && d.totalBytes <= 0 ? 'indet' : ''
  }`;
  p.firstElementChild.style.width = `${pct}%`;
  const tg = el.querySelector('.act-toggle');
  const mode = ACTIVE.has(d.status) ? 'pause' : d.status === 'completed' ? 'file' : 'play';
  if (tg.dataset.mode !== mode) {
    tg.dataset.mode = mode;
    tg.innerHTML = icon(mode);
    tg.title = mode === 'pause' ? 'Pause' : mode === 'file' ? 'Open' : 'Resume';
  }
}

function renderDownloads() {
  const list = $('#dl-list');
  const items = [...state.downloads.values()].sort((a, b) => b.createdAt - a.createdAt);
  const visible = items.filter(dlVisible);
  const existing = new Map($$('.item', list).map((el) => [el.dataset.id, el]));
  let prev = null;
  for (const d of visible) {
    let el = existing.get(d.id);
    if (!el) el = dlRow(d);
    existing.delete(d.id);
    updateDlRow(el, d);
    const want = prev ? prev.nextSibling : list.firstChild;
    if (el !== want) list.insertBefore(el, want);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
  $('#dl-empty').classList.toggle('show', !visible.length);
  const active = items.filter((d) => ACTIVE.has(d.status)).length;
  $('#badge-downloads').textContent = active || '';
  updateRates();
}

function updateRates() {
  let down = 0;
  for (const d of state.downloads.values()) if (d.status === 'downloading') down += d.speed || 0;
  $('#rate-down').textContent = rate(down);
  $('#rate-up').textContent = rate(state.uploadRate || 0);
}

$$('#dl-filter .chip').forEach((c) =>
  c.addEventListener('click', () => {
    $$('#dl-filter .chip').forEach((x) => x.classList.toggle('active', x === c));
    state.filter = c.dataset.filter;
    renderDownloads();
  })
);
$('#dl-search').addEventListener('input', (e) => {
  state.search = e.target.value.toLowerCase().trim();
  renderDownloads();
});
$('#btn-resume-all').addEventListener('click', () => call('downloads:resumeAll'));
$('#btn-pause-all').addEventListener('click', () => call('downloads:pauseAll'));
$('#btn-clear').addEventListener('click', () => call('downloads:clearCompleted'));

/* ------------------------------ add dialog ------------------------------- */

function openAdd(prefill = {}) {
  $('#add-urls').value = (prefill.urls || (prefill.url ? [prefill.url] : [])).join('\n');
  $('#add-name').value = prefill.filename || '';
  $('#add-dir').value = state.settings.lastLocalDir || state.settings.downloadDir || '';
  $('#add-conn').value = state.settings.connections || 8;
  $('#add-conn-val').textContent = $('#add-conn').value;
  $('#add-error').textContent = '';
  $('#modal-add').dataset.extra = JSON.stringify({ cookies: prefill.cookies, referrer: prefill.referrer, userAgent: prefill.userAgent });
  $('#modal-add').classList.add('show');
  if (!$('#add-urls').value) {
    api.invoke('clipboard:read').then((t) => {
      if (/^https?:\/\//i.test((t || '').trim()) && !$('#add-urls').value) $('#add-urls').value = t.trim();
    });
  }
  setTimeout(() => $('#add-urls').focus(), 50);
}
function closeModal() {
  $$('.modal-backdrop').forEach((m) => m.classList.remove('show'));
}
$$('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
$('#modal-add').addEventListener('click', (e) => e.target.id === 'modal-add' && closeModal());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    closeMenu();
  }
});
$('#btn-add').addEventListener('click', () => openAdd());
$('#add-conn').addEventListener('input', (e) => ($('#add-conn-val').textContent = e.target.value));
$('#add-browse').addEventListener('click', async () => {
  const p = await call('dialog:pickFolder', $('#add-dir').value);
  if (p) $('#add-dir').value = p;
});
$('#add-ok').addEventListener('click', async () => {
  const urls = $('#add-urls')
    .value.split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!urls.length) {
    $('#add-error').textContent = 'Paste at least one link.';
    return;
  }
  const extra = JSON.parse($('#modal-add').dataset.extra || '{}');
  $('#add-ok').disabled = true;
  try {
    const r = await call('downloads:add', {
      urls,
      dir: $('#add-dir').value,
      filename: urls.length === 1 ? $('#add-name').value.trim() || undefined : undefined,
      connections: Number($('#add-conn').value),
      start: $('#add-start').checked,
      ...extra
    });
    if (r.errors.length) $('#add-error').textContent = r.errors.join('\n');
    else closeModal();
    const transfers = r.results.filter((x) => x && x.transfer).length;
    if (transfers) toast(`Google Drive folder detected — started as a Drive Relay download (${transfers}).`, 'ok');
  } finally {
    $('#add-ok').disabled = false;
  }
});

/* drag & drop links */
const dropHint = document.createElement('div');
dropHint.className = 'drop-hint';
dropHint.textContent = 'Drop links to download';
document.body.appendChild(dropHint);
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if ([...e.dataTransfer.types].some((t) => t === 'text/uri-list' || t === 'text/plain')) {
    dragDepth++;
    dropHint.classList.add('show');
  }
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropHint.classList.remove('show');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropHint.classList.remove('show');
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  const urls = (text || '').split(/\s+/).filter((u) => /^https?:\/\//i.test(u));
  if (!urls.length) return;
  if ($('#page-relay').classList.contains('active')) {
    $('#relay-source').value = urls[0];
    updateSourceKind();
  } else openAdd({ urls });
});

/* --------------------------------- relay --------------------------------- */

function setMode(mode) {
  state.mode = mode;
  $$('#relay-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#step-local').classList.toggle('disabled', mode === 'copy');
  $('#step-dest').classList.toggle('disabled', mode === 'download');
  $('#opt-keep-wrap').style.display = mode === 'relay' ? '' : 'none';
  $('#opt-root-wrap').style.display = mode === 'download' ? 'none' : '';
  $('#relay-start').innerHTML = `${icon('rocket')}${mode === 'relay' ? 'Start relay' : mode === 'copy' ? 'Start cloud copy' : 'Start download'}`;
}
$$('#relay-mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

function detectLink(v) {
  v = (v || '').trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (/(drive|docs)\.google\.com|drive\.usercontent\.google\.com/.test(u.hostname)) {
      if (/\/folders\/|folderview/.test(u.pathname)) return ['drive', 'Google Drive folder'];
      return ['drive', 'Google Drive file'];
    }
    return ['url', 'Direct link'];
  } catch {
    if (/^[-\w]{20,}$/.test(v)) return ['drive', 'Google Drive ID'];
    return ['bad', 'Not a link'];
  }
}
function updateSourceKind() {
  const k = detectLink($('#relay-source').value);
  const el = $('#src-kind');
  el.className = `pill ${k ? k[0] : ''}`;
  el.textContent = k ? k[1] : '';
}
$('#relay-source').addEventListener('input', updateSourceKind);
$('#relay-paste-src').addEventListener('click', async () => {
  $('#relay-source').value = (await api.invoke('clipboard:read')).trim();
  updateSourceKind();
});
$('#relay-paste-dest').addEventListener('click', async () => {
  $('#relay-dest').value = (await api.invoke('clipboard:read')).trim();
});
$('#relay-browse').addEventListener('click', async () => {
  const p = await call('dialog:pickFolder', $('#relay-local').value);
  if (p) $('#relay-local').value = p;
});

function fillAccountSelects() {
  const dest = $('#relay-dest-account');
  const src = $('#relay-src-account');
  const curD = dest.value;
  const curS = src.value;
  dest.innerHTML = state.accounts.length
    ? state.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.email)}</option>`).join('')
    : '<option value="">— sign in on the Accounts page —</option>';
  src.innerHTML =
    '<option value="auto">Auto (accounts, then public)</option><option value="public">Public link (no account)</option>' +
    state.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.email)}</option>`).join('');
  if (curD && state.accounts.some((a) => a.id === curD)) dest.value = curD;
  if (curS) src.value = curS;
}

$('#relay-start').addEventListener('click', async () => {
  $('#relay-error').textContent = '';
  const btn = $('#relay-start');
  btn.disabled = true;
  try {
    await call('transfers:create', {
      source: $('#relay-source').value,
      destination: state.mode === 'download' ? '' : $('#relay-dest').value,
      localDir: $('#relay-local').value,
      mode: state.mode,
      keepLocal: $('#opt-keep').checked,
      skipExisting: $('#opt-skip').checked,
      verify: $('#opt-verify').checked,
      createRootFolder: $('#opt-root').checked,
      destAccount: $('#relay-dest-account').value || undefined,
      sourceAccount: $('#relay-src-account').value || 'auto'
    });
    $('#relay-source').value = '';
    updateSourceKind();
    toast('Transfer started', 'ok');
  } catch (e) {
    $('#relay-error').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

const MODE_ICON = { relay: 'relay', download: 'download', copy: 'cloud' };
const MODE_LABEL = { relay: 'Download → Upload', download: 'Download only', copy: 'Cloud copy' };

function trSub(t) {
  const c = t.counts;
  const parts = [];
  parts.push(`<span>${c.done}/${c.total} files</span>`);
  if (t.totalBytes) {
    if (t.mode === 'relay') parts.push(`<span>↓ ${bytes(t.downBytes)} · ↑ ${bytes(t.upBytes)} of ${bytes(t.totalBytes)}</span>`);
    else parts.push(`<span>${bytes(t.downBytes)} of ${bytes(t.totalBytes)}</span>`);
  }
  if (t.status === 'running' && t.speed) parts.push(`<span>${rate(t.speed)}</span>`);
  if (c.failed) parts.push(`<span class="err">${c.failed} failed</span>`);
  if (c.skipped) parts.push(`<span>${c.skipped} skipped</span>`);
  if (t.phase) parts.push(`<span>${esc(t.phase)}</span>`);
  if (t.error) parts.push(`<span class="err">${esc(t.error)}</span>`);
  return parts.join('');
}

function trRow(t) {
  const el = document.createElement('div');
  el.className = 'item transfer';
  el.dataset.id = t.id;
  el.innerHTML = `
    <div class="mode-ico">${icon(MODE_ICON[t.mode] || 'relay', '')}</div>
    <div class="item-main">
      <div class="item-title"></div>
      <div class="route"></div>
      <div class="item-sub"></div>
      <div class="progress"><div></div></div>
    </div>
    <div class="item-actions">
      <span class="status"></span>
      <button class="icon-btn act-toggle"></button>
      <button class="icon-btn act-expand" title="Show files">${icon('chevron')}</button>
      <button class="icon-btn act-more" title="More">${icon('more')}</button>
    </div>`;
  el.querySelector('.act-toggle').addEventListener('click', () => {
    const cur = state.transfers.get(t.id);
    if (['running', 'resolving', 'queued'].includes(cur.status)) call('transfers:pause', t.id);
    else if (cur.status === 'error') call('transfers:retry', t.id);
    else if (cur.status !== 'completed') call('transfers:resume', t.id);
  });
  el.querySelector('.act-expand').addEventListener('click', async () => {
    if (state.expanded.has(t.id)) {
      state.expanded.delete(t.id);
      state.details.delete(t.id);
    } else {
      state.expanded.add(t.id);
      state.details.set(t.id, await call('transfers:get', t.id));
    }
    renderTransfers();
  });
  el.querySelector('.act-more').addEventListener('click', (e) => {
    e.stopPropagation();
    const cur = state.transfers.get(t.id);
    openMenu(e.currentTarget, [
      cur.mode !== 'copy' && { icon: 'folder', label: 'Open local folder', run: () => call('transfers:openLocal', t.id) },
      cur.destination && { icon: 'external', label: 'Open destination in Drive', run: () => call('transfers:openDest', t.id) },
      cur.counts.failed && { icon: 'refresh', label: 'Retry failed files', run: () => call('transfers:retry', t.id) },
      !['completed', 'canceled'].includes(cur.status) && { icon: 'x', label: 'Cancel', run: () => call('transfers:cancel', t.id) },
      { icon: 'trash', label: 'Remove from list', danger: true, run: () => call('transfers:remove', t.id) }
    ]);
  });
  return el;
}

const ITEM_STATE = {
  pending: 'Waiting',
  downloading: 'Downloading',
  verifying: 'Verifying',
  downloaded: 'Downloaded',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  copying: 'Copying',
  done: 'Done',
  error: 'Failed',
  skipped: 'Skipped'
};

function detailsHtml(d) {
  if (!d || !d.items) return '<p class="muted small">Loading…</p>';
  if (!d.items.length) return '<p class="muted small">Resolving files…</p>';
  const rows = d.items.slice(0, 1000).map((it) => {
    const p = it.size > 0 ? Math.floor(((d.mode === 'relay' ? it.downloaded + it.uploaded : it.downloaded) / (it.size * (d.mode === 'relay' ? 2 : 1))) * 100) : null;
    return `<tr>
      <td class="name" title="${esc((it.relDir ? it.relDir + '/' : '') + it.name)}">${esc(it.relDir ? it.relDir + '/' : '')}<b>${esc(it.name)}</b></td>
      <td class="num">${it.size > 0 ? bytes(it.size) : ''}</td>
      <td class="num">${p != null && it.state !== 'done' && it.state !== 'pending' ? p + '%' : ''}</td>
      <td><span class="st ${it.state}">${ITEM_STATE[it.state] || it.state}</span>${it.error ? ` <span class="muted small" title="${esc(it.error)}">— ${esc(it.error.slice(0, 90))}</span>` : ''}</td>
    </tr>`;
  });
  const more = d.items.length > 1000 ? `<p class="muted small">…and ${d.items.length - 1000} more</p>` : '';
  return `<table class="files">${rows.join('')}</table>${more}`;
}

function updateTrRow(el, t) {
  el.querySelector('.item-title').textContent = t.title;
  el.querySelector('.route').innerHTML =
    t.mode === 'copy'
      ? `<span class="pill">${MODE_LABEL[t.mode]}</span> <span class="path">${esc(t.source)}</span> → <span class="path">${esc(t.destName || t.destination)}</span>`
      : t.mode === 'relay'
        ? `<span class="pill">${MODE_LABEL[t.mode]}</span> <span class="path">${esc(t.rootLocal)}</span> → <span class="path">Drive: ${esc(t.destName || '')}</span>${
            t.keepLocal ? '' : ' <span class="pill">local copy removed</span>'
          }`
        : `<span class="pill">${MODE_LABEL[t.mode]}</span> <span class="path">${esc(t.rootLocal)}</span>`;
  el.querySelector('.item-sub').innerHTML = trSub(t);
  const st = el.querySelector('.status');
  st.className = `status ${t.status}`;
  st.textContent = t.status === 'error' && t.counts.done ? 'partial' : t.status;
  const p = el.querySelector('.progress');
  p.className = `progress ${t.status === 'completed' ? 'done' : t.status === 'error' ? 'err' : t.status === 'paused' ? 'paused' : ''} ${
    t.status === 'resolving' ? 'indet' : ''
  }`;
  p.firstElementChild.style.width = `${Math.round((t.progress || 0) * 1000) / 10}%`;
  const tg = el.querySelector('.act-toggle');
  const mode = ['running', 'resolving', 'queued'].includes(t.status) ? 'pause' : t.status === 'error' ? 'refresh' : t.status === 'completed' ? 'check' : 'play';
  if (tg.dataset.mode !== mode) {
    tg.dataset.mode = mode;
    tg.innerHTML = icon(mode);
    tg.title = { pause: 'Pause', refresh: 'Retry failed', check: 'Completed', play: 'Resume' }[mode];
  }
  el.querySelector('.act-expand').style.transform = state.expanded.has(t.id) ? 'rotate(90deg)' : '';
  let det = el.querySelector('.details');
  if (state.expanded.has(t.id)) {
    if (!det) {
      det = document.createElement('div');
      det.className = 'details';
      el.appendChild(det);
    }
    det.innerHTML = detailsHtml(state.details.get(t.id));
  } else det?.remove();
}

function renderTransfers() {
  const list = $('#tr-list');
  const items = [...state.transfers.values()].sort((a, b) => b.createdAt - a.createdAt);
  const existing = new Map($$('.transfer', list).map((el) => [el.dataset.id, el]));
  let prev = null;
  for (const t of items) {
    let el = existing.get(t.id) || trRow(t);
    existing.delete(t.id);
    updateTrRow(el, t);
    const want = prev ? prev.nextSibling : list.firstChild;
    if (el !== want) list.insertBefore(el, want);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
  $('#tr-empty').classList.toggle('show', !items.length);
  $('#badge-relay').textContent = items.filter((t) => ['running', 'resolving'].includes(t.status)).length || '';
}

let detailTimer = null;
function scheduleDetails() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(async () => {
    for (const id of state.expanded) {
      const d = await api.invoke('transfers:get', id).catch(() => null);
      if (d) state.details.set(id, d);
    }
    renderTransfers();
  }, 300);
}

/* -------------------------------- accounts ------------------------------- */

function renderAccounts() {
  const list = $('#acc-list');
  list.innerHTML = '';
  for (const a of state.accounts) {
    const el = document.createElement('div');
    el.className = 'item account';
    el.innerHTML = `
      <div class="avatar">${a.photo ? `<img src="${esc(a.photo)}" alt="" referrerpolicy="no-referrer">` : esc((a.name || a.email || '?')[0].toUpperCase())}</div>
      <div class="item-main">
        <div class="item-title">${esc(a.name)}</div>
        <div class="item-sub"><span>${esc(a.email)}</span>${a.needsReauth ? '<span class="err">Session expired — sign in again</span>' : '<span class="ok">Connected</span>'}</div>
      </div>
      <div class="item-actions">
        ${a.needsReauth ? `<button class="btn act-reauth">${icon('refresh')}Sign in again</button>` : ''}
        <button class="btn ghost danger act-out">${icon('logout')}Sign out</button>
      </div>`;
    el.querySelector('.act-out').addEventListener('click', () => confirm(`Sign out ${a.email}?`) && call('accounts:signOut', a.id));
    el.querySelector('.act-reauth')?.addEventListener('click', signIn);
    list.appendChild(el);
  }
  $('#acc-empty').classList.toggle('show', !state.accounts.length);
  $('#badge-accounts').textContent = !state.info.googleConfigured || state.accounts.some((a) => a.needsReauth) ? '!' : '';
  $('#google-setup').style.display = state.info.googleConfigured && state.accounts.length ? 'none' : '';
  fillAccountSelects();
}

async function signIn() {
  if (!state.info.googleConfigured) {
    toast('First add your Google API Client ID and Secret (see the setup card).', 'err');
    return;
  }
  const btn = $('#btn-signin');
  btn.disabled = true;
  btn.innerHTML = `${icon('external')}Continue in your browser…`;
  try {
    const a = await call('accounts:signIn');
    toast(`Connected ${a.email}`, 'ok');
  } catch {
    /* toast shown */
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${icon('plus')}Add Google account`;
  }
}
$('#btn-signin').addEventListener('click', signIn);

async function saveClient(google) {
  state.settings = await call('settings:set', { google });
  state.info = await call('app:info');
  $('#g-client-id').value = state.settings.google.clientId || '';
  $('#g-client-secret').value = state.settings.google.clientSecret || '';
  $('#client-status').textContent = state.info.googleConfigured ? '✓ Saved. Now click "Add Google account".' : '';
  renderAccounts();
}
$('#btn-save-client').addEventListener('click', () =>
  saveClient({ clientId: $('#g-client-id').value.trim(), clientSecret: $('#g-client-secret').value.trim() })
);
$('#btn-import-json').addEventListener('click', async () => {
  const g = await call('dialog:importClientJson');
  if (g) saveClient(g);
});
$('#link-guide').addEventListener('click', (e) => {
  e.preventDefault();
  call('shell:openExternal', 'https://github.com/mahirshahriar01/automatic-dowload-upload-agent/blob/main/docs/GOOGLE_SETUP.md');
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-ext]');
  if (a) {
    e.preventDefault();
    call('shell:openExternal', a.dataset.ext);
  }
});

/* ------------------------------- extension ------------------------------- */

async function refreshBridge() {
  state.bridge = await api.invoke('bridge:status');
  renderBridge();
}
function renderBridge() {
  const b = state.bridge || {};
  const connected = b.extensionLastSeen && Date.now() - b.extensionLastSeen < 90 * 1000;
  $('#ext-dot').className = `dot big ${connected ? 'on' : ''}`;
  $('#dot-ext').className = `dot ${connected ? 'on' : ''}`;
  $('#ext-status').textContent = connected
    ? 'Browser extension connected'
    : b.extensionLastSeen
      ? `Extension last seen ${ago(b.extensionLastSeen)}`
      : 'Extension not connected yet';
  $('#bridge-status').textContent = b.running
    ? `Local bridge listening on http://127.0.0.1:${b.port}`
    : `Local bridge is not running: ${b.error || 'unknown error'} — change the port in Settings.`;
}
$('#btn-ext-folder').addEventListener('click', () => call('shell:openPath', state.info.extensionDir));
setInterval(renderBridge, 10000);

/* -------------------------------- settings ------------------------------- */

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme || 'dark';
}
function renderSettings() {
  $$('[data-setting]').forEach((el) => {
    const v = state.settings[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  });
  $('#g-client-id').value = state.settings.google?.clientId || '';
  $('#g-client-secret').value = state.settings.google?.clientSecret || '';
  $('#about-line').textContent = `DriveRelay ${state.info.version} · ${state.info.platform} · data: ${state.info.userData}`;
  applyTheme();
}
$$('[data-setting]').forEach((el) =>
  el.addEventListener('change', async () => {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.type === 'number') v = Math.max(Number(el.min || 0), Number(v) || 0);
    state.settings = await call('settings:set', { [el.dataset.setting]: v });
    applyTheme();
    toast('Saved');
  })
);
$('#set-browse').addEventListener('click', async () => {
  const p = await call('dialog:pickFolder', state.settings.downloadDir);
  if (p) {
    state.settings = await call('settings:set', { downloadDir: p });
    renderSettings();
  }
});

/* --------------------------------- events -------------------------------- */

api.on('downloads:progress', (views) => {
  for (const v of views) state.downloads.set(v.id, v);
  renderDownloads();
});
api.on('downloads:task', (v) => {
  state.downloads.set(v.id, v);
  renderDownloads();
});
api.on('downloads:removed', (id) => {
  state.downloads.delete(id);
  renderDownloads();
});
api.on('transfers:update', (v) => {
  state.transfers.set(v.id, v);
  state.uploadRate = computeUploadRate();
  if (state.expanded.has(v.id)) scheduleDetails();
  renderTransfers();
  updateRates();
});
api.on('transfers:removed', (id) => {
  state.transfers.delete(id);
  state.expanded.delete(id);
  renderTransfers();
});
api.on('accounts:changed', (a) => {
  state.accounts = a;
  renderAccounts();
});
api.on('bridge:status', (b) => {
  state.bridge = b;
  renderBridge();
});
api.on('nav', (page) => nav(page));
api.on('prefill:download', (b) => {
  nav('downloads');
  openAdd(b);
});
api.on('prefill:relay', (b) => {
  nav('relay');
  $('#relay-source').value = b.source || '';
  updateSourceKind();
  $('#relay-dest').focus();
});

function computeUploadRate() {
  // transfer.speed = download speed of its files + upload speed; subtract the download part.
  let total = 0;
  for (const t of state.transfers.values()) if (t.status === 'running') total += t.speed || 0;
  let down = 0;
  for (const d of state.downloads.values()) if (d.status === 'downloading' && d.meta && d.meta.transfer) down += d.speed || 0;
  return Math.max(0, total - down);
}

/* ---------------------------------- init --------------------------------- */

(async function init() {
  if (api.platform === 'darwin') document.body.classList.add('mac');
  hydrateIcons();
  const [settings, info, dls, trs, accs] = await Promise.all([
    api.invoke('settings:get'),
    api.invoke('app:info'),
    api.invoke('downloads:list'),
    api.invoke('transfers:list'),
    api.invoke('accounts:list')
  ]);
  state.settings = settings;
  state.info = info;
  state.bridge = info.bridge;
  for (const d of dls) state.downloads.set(d.id, d);
  for (const t of trs) state.transfers.set(t.id, t);
  state.accounts = accs;
  $('#relay-local').value = settings.lastLocalDir || settings.downloadDir;
  $('#relay-dest').value = settings.lastDestination || '';
  $('#opt-keep').checked = settings.defaultKeepLocal !== false;
  setMode('relay');
  renderSettings();
  renderDownloads();
  renderTransfers();
  renderAccounts();
  renderBridge();
  if (!info.googleConfigured) $('#client-status').textContent = 'Not configured yet.';
})();
