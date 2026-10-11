'use strict';

const ext = globalThis.browser || globalThis.chrome;
const $ = (s) => document.querySelector(s);
const send = (msg) => ext.runtime.sendMessage(msg);

function show(text, kind = '') {
  const m = $('#msg');
  m.className = `msg ${kind}`;
  m.textContent = text;
}

async function refresh(force) {
  const r = await send({ type: 'status', force });
  const on = !!r.status;
  $('#dot').className = `dot ${on ? 'on' : 'off'}`;
  $('#status').textContent = on ? `Connected to app v${r.status.version}` : 'App not running — start DriveRelay';
  $('#enabled').checked = !!r.cfg.enabled;
  if (on && !r.status.capture) $('#status').textContent += ' (capture off in app settings)';
}

async function act(promise, okText) {
  try {
    const r = await promise;
    if (r && r.ok === false) throw new Error(r.error);
    show(okText(r || {}), 'ok');
  } catch (e) {
    show(e.message || String(e), 'err');
  }
}

(async () => {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (tab && /^https:\/\/(drive|docs)\.google\.com\//.test(tab.url || '')) $('#drive-block').hidden = false;

  $('#enabled').addEventListener('change', async (e) => {
    await send({ type: 'setEnabled', enabled: e.target.checked });
    show(e.target.checked ? 'Downloads will be sent to DriveRelay' : 'Browser will handle downloads');
  });
  $('#btn-dl').addEventListener('click', () => {
    const url = $('#url').value.trim();
    if (!url) return show('Paste a link first', 'err');
    act(send({ type: 'download', url, referrer: tab && tab.url }), () => 'Sent to DriveRelay');
  });
  $('#btn-relay').addEventListener('click', () => {
    const url = $('#url').value.trim();
    if (!url) return show('Paste a link first', 'err');
    act(send({ type: 'relay', url }), () => 'Opened in Drive Relay');
  });
  $('#btn-relay-tab').addEventListener('click', () => act(send({ type: 'relay', url: tab.url }), () => 'Opened in Drive Relay'));
  $('#btn-all').addEventListener('click', () =>
    act(send({ type: 'grabAll', tabId: tab.id, pageUrl: tab.url }), (r) => `${r.count} link(s) sent to DriveRelay`)
  );
  $('#btn-open').addEventListener('click', () => act(send({ type: 'show' }), () => 'Opening…'));
  $('#opts').addEventListener('click', (e) => {
    e.preventDefault();
    ext.runtime.openOptionsPage();
  });
  refresh(true);
})();
