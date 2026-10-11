'use strict';

const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Tray,
  Menu,
  Notification,
  nativeImage,
  safeStorage,
  clipboard,
  nativeTheme
} = require('electron');

const { JsonStore } = require('./store');
const { DownloadManager } = require('./downloader/manager');
const { GoogleAuth } = require('./google/auth');
const drive = require('./google/drive');
const { TransferManager } = require('./transfer');
const { BridgeServer } = require('./server');
const { resolveDirectUrl } = require('./resolvers');
const { formatBytes } = require('./utils');

const isMac = process.platform === 'darwin';
const ROOT = path.join(__dirname, '..', '..');
const ICON = path.join(__dirname, '..', 'renderer', 'assets', 'icon.png');

// Lets automated tests run with an isolated profile.
if (process.env.DRIVERELAY_USER_DATA) app.setPath('userData', process.env.DRIVERELAY_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('com.driverelay.app');

let win = null;
let tray = null;
let quitting = false;
let settings, downloads, transfers, auth, bridge, stores;

/* -------------------------------- settings ------------------------------- */

function defaultSettings() {
  return {
    downloadDir: app.getPath('downloads'),
    connections: 8,
    maxConcurrent: 3,
    uploadConcurrency: 2,
    speedLimitKBps: 0,
    maxRetries: 6,
    autoResume: true,
    notify: true,
    minimizeToTray: true,
    launchAtLogin: false,
    theme: 'dark',
    serverPort: 6801,
    captureFromBrowser: true,
    askBeforeDownload: false,
    captureMinSizeKB: 512,
    captureExtensions: '',
    defaultKeepLocal: true,
    google: { clientId: '', clientSecret: '' },
    lastLocalDir: '',
    lastDestination: ''
  };
}

function encrypt(str) {
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(str).toString('base64');
  return 'b64:' + Buffer.from(str).toString('base64');
}

function decrypt(str) {
  if (str.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(str.slice(4), 'base64'));
  if (str.startsWith('b64:')) return Buffer.from(str.slice(4), 'base64').toString();
  return str;
}

/* --------------------------------- window -------------------------------- */

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'DriveRelay',
    backgroundColor: '#0b1020',
    icon: ICON,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });
  win.on('close', (e) => {
    if (!quitting && settings.data.minimizeToTray) {
      e.preventDefault();
      win.hide();
      if (isMac) app.dock?.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function showWindow(page) {
  if (!win || win.isDestroyed()) createWindow();
  if (isMac) app.dock?.show();
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  if (page) send('nav', page);
}

function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: isMac ? 18 : 16, height: isMac ? 18 : 16 });
  tray = new Tray(img);
  tray.setToolTip('DriveRelay');
  const menu = Menu.buildFromTemplate([
    { label: 'Open DriveRelay', click: () => showWindow() },
    { label: 'New Drive Relay…', click: () => showWindow('relay') },
    { type: 'separator' },
    { label: 'Resume all', click: () => downloads.resumeAll() },
    { label: 'Pause all', click: () => downloads.pauseAll() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showWindow());
}

function notify(title, body, onClick) {
  if (!settings.data.notify || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON, silent: false });
  if (onClick) n.on('click', onClick);
  n.show();
}

/* ------------------------------ download glue ---------------------------- */

/**
 * Add one URL from the UI / extension. Google Drive links are resolved to the
 * actual file (or become a folder transfer); hosting share pages are converted.
 */
async function addUrl(url, o = {}) {
  url = String(url || '').trim();
  if (!url) return null;
  const dir = o.dir || settings.data.downloadDir;
  const link = drive.isDriveLink(url) ? drive.parseDriveLink(url) : null;
  if (link) {
    if (link.kind === 'folder') {
      return { transfer: await transfers.create({ source: url, localDir: dir, mode: 'download' }) };
    }
    for (const acc of auth.accounts()) {
      try {
        const f = await new drive.DriveClient(auth, acc.id).getFile(link.id, link.resourceKey);
        if (f.mimeType === drive.FOLDER_MIME) {
          return { transfer: await transfers.create({ source: url, localDir: dir, mode: 'download', sourceAccount: acc.id }) };
        }
        const ex = drive.exportInfo(f.mimeType);
        const name = ex && !f.name.endsWith(ex.ext) ? f.name + ex.ext : f.name;
        const t = downloads.add({
          url: drive.apiDownloadUrl(f),
          dir,
          filename: o.filename || name,
          size: ex ? -1 : Number(f.size || -1),
          connections: o.connections,
          auth: { type: 'google', accountId: acc.id },
          meta: { source: url }
        });
        return { download: t.view() };
      } catch {
        /* try next account / public */
      }
    }
    try {
      const r = await drive.resolvePublicFile(link.id, link.resourceKey);
      const t = downloads.add({ url: r.url, dir, filename: o.filename || r.name, connections: o.connections, meta: { source: url } });
      return { download: t.view() };
    } catch (e) {
      if (link.kind === 'unknown') return { transfer: await transfers.create({ source: url, localDir: dir, mode: 'download' }) };
      throw e;
    }
  }
  const r = await resolveDirectUrl(url);
  const headers = {};
  if (o.cookies) headers.Cookie = o.cookies;
  if (o.referrer) headers.Referer = o.referrer;
  if (o.userAgent) headers['User-Agent'] = o.userAgent;
  const t = downloads.add({
    url: r.url,
    dir,
    filename: o.filename || r.name,
    connections: o.connections,
    headers,
    start: o.start !== false,
    meta: { source: url, referrer: o.referrer }
  });
  return { download: t.view() };
}

/* ---------------------------------- IPC ---------------------------------- */

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (_e, ...args) => fn(...args));

  h('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
    extensionDir: extensionDir(),
    bridge: bridge.status(),
    googleConfigured: !!(settings.data.google.clientId && settings.data.google.clientSecret)
  }));

  h('settings:get', () => settings.data);
  h('settings:set', async (patch) => {
    const before = { ...settings.data };
    Object.assign(settings.data, patch);
    if (patch.google) settings.data.google = { ...before.google, ...patch.google };
    settings.saveNow();
    if (patch.speedLimitKBps !== undefined) downloads.setSpeedLimit(settings.data.speedLimitKBps);
    if (patch.serverPort && patch.serverPort !== before.serverPort) await bridge.restart(Number(patch.serverPort));
    if (patch.launchAtLogin !== undefined && (isMac || process.platform === 'win32')) {
      app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin, args: ['--hidden'] });
    }
    if (patch.theme) nativeTheme.themeSource = patch.theme === 'system' ? 'system' : patch.theme;
    return settings.data;
  });

  h('dialog:pickFolder', async (current) => {
    const r = await dialog.showOpenDialog(win, {
      defaultPath: current || settings.data.downloadDir,
      properties: ['openDirectory', 'createDirectory']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  h('dialog:importClientJson', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Select the client_secret_….json downloaded from Google Cloud Console',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (r.canceled) return null;
    const j = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    const c = j.installed || j.web || j;
    if (!c.client_id || !c.client_secret) throw new Error('This file does not contain a client_id / client_secret.');
    settings.data.google = { clientId: c.client_id, clientSecret: c.client_secret };
    settings.saveNow();
    return settings.data.google;
  });

  // downloads
  h('downloads:list', () => downloads.list());
  h('downloads:add', async ({ urls, ...o }) => {
    const results = [];
    const errors = [];
    for (const u of urls) {
      try {
        results.push(await addUrl(u, o));
      } catch (e) {
        errors.push(`${u}: ${e.message}`);
      }
    }
    if (o.dir) {
      settings.data.lastLocalDir = o.dir;
      settings.save();
    }
    return { results, errors };
  });
  h('downloads:pause', (id) => downloads.pause(id));
  h('downloads:resume', (id) => downloads.resume(id));
  h('downloads:restart', (id) => downloads.restart(id));
  h('downloads:remove', (id, deleteFile) => downloads.remove(id, deleteFile));
  h('downloads:pauseAll', () => downloads.pauseAll());
  h('downloads:resumeAll', () => downloads.resumeAll());
  h('downloads:clearCompleted', () => downloads.clearCompleted());
  h('downloads:open', (id) => {
    const t = downloads.get(id);
    if (t && t.status === 'completed') return shell.openPath(t.savePath);
  });
  h('downloads:showInFolder', (id) => {
    const t = downloads.get(id);
    if (!t) return;
    if (t.status === 'completed' && fs.existsSync(t.savePath)) shell.showItemInFolder(t.savePath);
    else shell.openPath(t.dir);
  });
  h('downloads:copyLink', (id) => {
    const t = downloads.get(id);
    if (t) clipboard.writeText(t.meta?.source || t.url);
  });

  // transfers
  h('transfers:list', () => transfers.list());
  h('transfers:get', (id) => transfers.get(id));
  h('transfers:create', async (o) => {
    const v = await transfers.create(o);
    settings.data.lastLocalDir = o.localDir || settings.data.lastLocalDir;
    if (o.destination) settings.data.lastDestination = o.destination;
    settings.save();
    return v;
  });
  h('transfers:pause', (id) => transfers.pause(id));
  h('transfers:resume', (id) => transfers.resume(id));
  h('transfers:retry', (id) => transfers.retryFailed(id));
  h('transfers:cancel', (id) => transfers.cancel(id));
  h('transfers:remove', (id) => transfers.remove(id));
  h('transfers:openLocal', (id) => {
    const v = transfers.get(id);
    if (v) shell.openPath(fs.existsSync(v.rootLocal) ? v.rootLocal : v.localDir);
  });
  h('transfers:openDest', (id) => {
    const v = transfers.get(id);
    if (v && v.destination) {
      const l = drive.parseDriveLink(v.destination);
      shell.openExternal(l ? `https://drive.google.com/drive/folders/${l.id}` : v.destination);
    }
  });
  h('drive:inspect', (url) => {
    const l = drive.parseDriveLink(url);
    if (!l) return null;
    return l;
  });

  // accounts
  h('accounts:list', () => auth.accounts());
  h('accounts:signIn', async () => {
    const a = await auth.signIn();
    showWindow();
    return a;
  });
  h('accounts:cancelSignIn', () => auth.cancelSignIn());
  h('accounts:signOut', (id) => auth.signOut(id));

  // misc
  h('shell:openExternal', (url) => /^https?:/.test(url) && shell.openExternal(url));
  h('shell:openPath', (p) => shell.openPath(p));
  h('clipboard:read', () => clipboard.readText());
  h('bridge:status', () => bridge.status());
}

function extensionDir() {
  const packaged = path.join(process.resourcesPath || '', 'extension');
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  return path.join(ROOT, 'dist-extension');
}

/* -------------------------------- startup -------------------------------- */

app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  settings = new JsonStore(path.join(userData, 'settings.json'), defaultSettings());
  settings.data.google = { ...defaultSettings().google, ...settings.data.google };
  stores = {
    downloads: new JsonStore(path.join(userData, 'downloads.json'), []),
    transfers: new JsonStore(path.join(userData, 'transfers.json'), []),
    accounts: new JsonStore(path.join(userData, 'accounts.json'), { accounts: [] })
  };
  nativeTheme.themeSource = settings.data.theme === 'system' ? 'system' : settings.data.theme;

  auth = new GoogleAuth({
    store: stores.accounts,
    getClient: () => settings.data.google,
    openExternal: (u) => shell.openExternal(u),
    encrypt,
    decrypt
  });
  auth.on('changed', () => send('accounts:changed', auth.accounts()));

  downloads = new DownloadManager({
    store: stores.downloads,
    settings: () => settings.data,
    getAuthHeaders: async (task) =>
      task.auth && task.auth.type === 'google' ? { Authorization: `Bearer ${await auth.getAccessToken(task.auth.accountId)}` } : {},
    onAuthError: async (task) => {
      if (task.auth && task.auth.type === 'google') await auth.getAccessToken(task.auth.accountId, true);
    },
    onProbe: async (task, res) => {
      const type = res.headers.get('content-type') || '';
      if (type.includes('text/html') && /google(usercontent|apis)?\.com/.test(res.url)) {
        throw new Error('Google returned a web page instead of the file (private file or quota exceeded). Sign in and retry.');
      }
    }
  });
  downloads.on('progress', (views) => send('downloads:progress', views));
  downloads.on('task', (v) => send('downloads:task', v));
  downloads.on('removed', (id) => send('downloads:removed', id));
  downloads.on('completed', (t) => {
    if (!t.transferId) {
      notify('Download complete', `${t.filename} (${formatBytes(t.totalBytes)})`, () => shell.showItemInFolder(t.savePath));
    }
  });
  downloads.on('failed', (t) => {
    if (!t.transferId) notify('Download failed', `${t.filename || t.url}: ${t.error}`);
  });

  transfers = new TransferManager({
    store: stores.transfers,
    downloads,
    auth,
    settings: () => settings.data
  });
  transfers.on('update', (v) => send('transfers:update', v));
  transfers.on('removed', (id) => send('transfers:removed', id));
  transfers.on('finished', (v) => {
    if (v.status === 'completed') {
      const what = v.mode === 'download' ? 'downloaded' : v.mode === 'copy' ? 'copied to Drive' : 'downloaded and uploaded to Drive';
      notify('Drive Relay finished', `${v.title}: ${v.counts.done} file(s) ${what}`, () => showWindow('relay'));
    } else if (v.status === 'error') {
      notify('Drive Relay problem', `${v.title}: ${v.error}`, () => showWindow('relay'));
    }
  });

  bridge = new BridgeServer({
    port: Number(settings.data.serverPort) || 6801,
    version: app.getVersion(),
    handlers: {
      status: () => ({
        capture: !!settings.data.captureFromBrowser,
        minSizeKB: Number(settings.data.captureMinSizeKB) || 0,
        extensions: settings.data.captureExtensions || ''
      }),
      download: async (b) => {
        if (!b.url) throw new Error('url is required');
        if (settings.data.askBeforeDownload) {
          showWindow('downloads');
          send('prefill:download', b);
          return { queued: false, prompted: true };
        }
        const r = await addUrl(b.url, b);
        const name = r?.download?.filename || b.filename || b.url;
        notify('Download added', name);
        return { queued: true };
      },
      downloads: async (b) => {
        const items = Array.isArray(b.items) ? b.items : [];
        if (settings.data.askBeforeDownload) {
          showWindow('downloads');
          send('prefill:download', { urls: items.map((i) => i.url), referrer: b.referrer });
          return { prompted: true };
        }
        for (const it of items) await addUrl(it.url, { ...b, ...it }).catch(() => {});
        notify('Downloads added', `${items.length} link(s) added to the queue`);
        return { queued: items.length };
      },
      relay: async (b) => {
        showWindow('relay');
        send('prefill:relay', { source: b.source || b.url || '' });
        return {};
      },
      show: async () => showWindow()
    }
  });
  bridge.on('status', () => send('bridge:status', bridge.status()));
  await bridge.start();

  registerIpc();
  createWindow();
  createTray();

  if (isMac) {
    app.dock?.setIcon(ICON);
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' }
      ])
    );
  } else {
    Menu.setApplicationMenu(null);
  }
});

app.on('activate', () => showWindow());

app.on('before-quit', (e) => {
  if (app._cleanedUp) return;
  e.preventDefault();
  quitting = true;
  app._cleanedUp = true;
  Promise.allSettled([transfers?.shutdown(), downloads?.shutdown(), bridge?.stop()]).finally(() => {
    settings?.flush();
    stores?.accounts.flush();
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (!settings?.data.minimizeToTray && !isMac) app.quit();
});
