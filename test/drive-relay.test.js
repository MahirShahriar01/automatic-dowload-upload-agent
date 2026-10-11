'use strict';

/**
 * End-to-end Drive Relay test against a mock Google Drive API server:
 * folder listing, segmented authorised downloads, Google Docs export,
 * resumable chunked upload (with injected 503 failures), destination folder
 * re-creation and server-side copy.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const files = new Map(); // id -> { id, name, mimeType, parents, data }
let seq = 0;
const newId = () => 'id' + String(++seq).padStart(24, '0');
function add(name, parent, data, mimeType = 'application/octet-stream') {
  const f = { id: newId(), name, mimeType, parents: parent ? [parent] : [], data };
  files.set(f.id, f);
  return f;
}
const FOLDER = 'application/vnd.google-apps.folder';
const meta = (f) => ({
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  parents: f.parents,
  size: f.data && f.mimeType !== FOLDER && !f.mimeType.startsWith('application/vnd.google-apps') ? String(f.data.length) : undefined,
  md5Checksum: f.data && !f.mimeType.startsWith('application/vnd.google-apps') ? crypto.createHash('md5').update(f.data).digest('hex') : undefined,
  capabilities: { canAddChildren: true }
});

const sessions = new Map();
let injectFailures = 2;
let base;

function readBody(req) {
  return new Promise((r) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => r(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, base);
  const send = (status, obj, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(obj === undefined ? '' : JSON.stringify(obj));
  };
  if (req.headers.authorization !== 'Bearer test-token') return send(401, { error: { message: 'bad auth' } });
  let m;
  // ---- upload session PUTs
  if ((m = /^\/upload\/session\/(\w+)$/.exec(u.pathname)) && req.method === 'PUT') {
    const s = sessions.get(m[1]);
    const body = await readBody(req);
    const cr = req.headers['content-range'];
    if (/^bytes \*\//.test(cr)) {
      if (s.received === s.size) return send(200, meta(s.file));
      return send(308, undefined, s.received ? { Range: `bytes=0-${s.received - 1}` } : {});
    }
    const [, a, b, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(cr).map(Number);
    if (injectFailures > 0 && a > 0) {
      injectFailures--;
      return send(503, { error: { message: 'try again' } });
    }
    assert.strictEqual(a, s.received, 'chunk must start where the last one ended');
    assert.strictEqual(body.length, b - a + 1);
    s.chunks.push(body);
    s.received = b + 1;
    if (s.received < total) return send(308, undefined, { Range: `bytes=0-${b}` });
    s.file = add(s.name, s.parent, Buffer.concat(s.chunks), s.mime);
    return send(200, meta(s.file));
  }
  // ---- start resumable / multipart upload
  if (u.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
    const body = await readBody(req);
    if (u.searchParams.get('uploadType') === 'resumable') {
      const j = JSON.parse(body.toString());
      const sid = crypto.randomBytes(6).toString('hex');
      sessions.set(sid, { name: j.name, parent: j.parents[0], size: Number(req.headers['x-upload-content-length']), mime: req.headers['x-upload-content-type'], received: 0, chunks: [] });
      return send(200, {}, { Location: `${base}/upload/session/${sid}` });
    }
    const j = JSON.parse(/\r\n\r\n(\{.*?\})\r\n/s.exec(body.toString())[1]);
    return send(200, meta(add(j.name, j.parents[0], Buffer.alloc(0))));
  }
  // ---- export google docs
  if ((m = /^\/drive\/v3\/files\/(\w+)\/export$/.exec(u.pathname))) {
    const f = files.get(m[1]);
    res.writeHead(200, { 'Content-Type': u.searchParams.get('mimeType'), 'Content-Length': f.data.length });
    return res.end(f.data);
  }
  // ---- copy
  if ((m = /^\/drive\/v3\/files\/(\w+)\/copy$/.exec(u.pathname)) && req.method === 'POST') {
    const j = JSON.parse((await readBody(req)).toString());
    const src = files.get(m[1]);
    return send(200, meta(add(j.name || src.name, j.parents[0], src.data, src.mimeType)));
  }
  // ---- metadata / media
  if ((m = /^\/drive\/v3\/files\/(\w+)$/.exec(u.pathname)) && req.method === 'GET') {
    const f = files.get(m[1]);
    if (!f) return send(404, { error: { message: 'File not found' } });
    if (u.searchParams.get('alt') !== 'media') return send(200, meta(f));
    const r = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (r) {
      const s = Number(r[1]);
      const e = r[2] ? Math.min(Number(r[2]), f.data.length - 1) : f.data.length - 1;
      if (f.data.length === 0) {
        res.writeHead(416, { 'Content-Range': 'bytes */0' });
        return res.end();
      }
      res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/${f.data.length}`, 'Content-Length': e - s + 1 });
      return res.end(f.data.subarray(s, e + 1));
    }
    res.writeHead(200, { 'Content-Length': f.data.length });
    return res.end(f.data);
  }
  // ---- list / search
  if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
    const q = u.searchParams.get('q');
    const parent = /'(\w+)' in parents/.exec(q)[1];
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q);
    let list = [...files.values()].filter((f) => f.parents.includes(parent));
    if (name) list = list.filter((f) => f.name === name[1].replace(/\\(.)/g, '$1'));
    if (/mimeType = 'application\/vnd.google-apps.folder'/.test(q)) list = list.filter((f) => f.mimeType === FOLDER);
    if (/mimeType != 'application\/vnd.google-apps.folder'/.test(q)) list = list.filter((f) => f.mimeType !== FOLDER);
    return send(200, { files: list.map(meta) });
  }
  // ---- create folder
  if (u.pathname === '/drive/v3/files' && req.method === 'POST') {
    const j = JSON.parse((await readBody(req)).toString());
    return send(200, meta(add(j.name, j.parents[0], null, j.mimeType)));
  }
  send(404, { error: { message: 'unknown route ' + u.pathname } });
});

const fakeAuth = {
  getAccessToken: async () => 'test-token',
  accounts: () => [{ id: 'me@example.com' }],
  hasAccount: () => true,
  defaultAccountId: () => 'me@example.com'
};

const memStore = (data) => ({ data, save() {}, saveNow() {}, flush() {} });

let TransferManager, DownloadManager, DriveClient;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  if (process.env.DBG) server.on('request', (q) => console.error('REQ', q.method, q.url));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.DRIVERELAY_GOOGLE_API = base;
  process.env.DRIVERELAY_UPLOAD_CHUNK = String(256 * 1024);
  ({ TransferManager } = require('../src/main/transfer'));
  ({ DownloadManager } = require('../src/main/downloader/manager'));
  ({ DriveClient } = require('../src/main/google/drive'));
});
test.after(() => {
  server.close();
  server.closeAllConnections();
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-relay-'));
  const settings = () => ({ downloadDir: dir, maxConcurrent: 3, connections: 4, uploadConcurrency: 2 });
  const downloads = new DownloadManager({
    store: memStore([]),
    settings,
    getAuthHeaders: async (t) => (t.auth ? { Authorization: `Bearer ${await fakeAuth.getAccessToken()}` } : {})
  });
  const transfers = new TransferManager({
    store: memStore([]),
    downloads,
    auth: fakeAuth,
    settings,
    clientFactory: (acc) => new DriveClient(fakeAuth, acc)
  });
  if (process.env.DBG) {
    transfers.on('update', (v) => console.error('T', v.status, v.phase, v.error, JSON.stringify(v.counts)));
    downloads.on('task', (v) => console.error('D', v.filename, v.status, v.error));
  }
  return { dir, downloads, transfers };
}

function waitFinished(transfers, jobId) {
  return new Promise((resolve) => {
    const on = (v) => v.id === jobId && (transfers.off('finished', on), resolve(v));
    transfers.on('finished', on);
  });
}

const childByName = (parentId, name) => [...files.values()].find((f) => f.parents.includes(parentId) && f.name === name);

test('relay: Drive folder -> local -> Drive folder (structure, content, resume on 503)', async () => {
  const src = add('My Project', null, null, FOLDER);
  const big = crypto.randomBytes(2 * 1024 * 1024 + 777);
  add('video.bin', src.id, big);
  const sub = add('Sub Folder', src.id, null, FOLDER);
  add('notes.txt', sub.id, Buffer.from('hello relay'), 'text/plain');
  add('empty.dat', sub.id, Buffer.alloc(0));
  add('Report', src.id, Buffer.from('docx-bytes'), 'application/vnd.google-apps.document');
  const dest = add('Destination', null, null, FOLDER);

  const { dir, downloads, transfers } = setup();
  const view = await transfers.create({
    source: `https://drive.google.com/drive/folders/${src.id}?usp=sharing`,
    destination: `https://drive.google.com/drive/folders/${dest.id}`,
    mode: 'relay',
    keepLocal: true
  });
  const done = await waitFinished(transfers, view.id);
  assert.strictEqual(done.status, 'completed', done.error);
  assert.strictEqual(done.counts.done, 4);

  // local mirror
  assert.ok(fs.readFileSync(path.join(dir, 'My Project', 'video.bin')).equals(big));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'My Project', 'Sub Folder', 'notes.txt'), 'utf8'), 'hello relay');
  assert.strictEqual(fs.statSync(path.join(dir, 'My Project', 'Sub Folder', 'empty.dat')).size, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'My Project', 'Report.docx'), 'utf8'), 'docx-bytes');

  // destination drive
  const root = childByName(dest.id, 'My Project');
  assert.ok(root && root.mimeType === FOLDER);
  assert.ok(childByName(root.id, 'video.bin').data.equals(big));
  assert.strictEqual(childByName(root.id, 'Report.docx').data.toString(), 'docx-bytes');
  const rsub = childByName(root.id, 'Sub Folder');
  assert.strictEqual(childByName(rsub.id, 'notes.txt').data.toString(), 'hello relay');
  assert.strictEqual(childByName(rsub.id, 'empty.dat').data.length, 0);
  assert.strictEqual(injectFailures, 0, 'upload failures were injected and recovered');

  await transfers.shutdown();
  await downloads.shutdown();
});

test('relay with keepLocal=false removes local copies', async () => {
  const f = add('single.zip', null, crypto.randomBytes(300000));
  const dest = add('Dest2', null, null, FOLDER);
  const { dir, downloads, transfers } = setup();
  const view = await transfers.create({
    source: `https://drive.google.com/file/d/${f.id}/view?usp=sharing`,
    destination: `https://drive.google.com/drive/folders/${dest.id}`,
    mode: 'relay',
    keepLocal: false
  });
  const done = await waitFinished(transfers, view.id);
  assert.strictEqual(done.status, 'completed', done.error);
  assert.ok(childByName(dest.id, 'single.zip').data.equals(f.data));
  assert.ok(!fs.existsSync(path.join(dir, 'single.zip')));
  await transfers.shutdown();
  await downloads.shutdown();
});

test('cloud copy mode copies server-side', async () => {
  const src = add('CopySrc', null, null, FOLDER);
  add('a.txt', src.id, Buffer.from('A'));
  const inner = add('inner', src.id, null, FOLDER);
  add('b.txt', inner.id, Buffer.from('B'));
  const dest = add('Dest3', null, null, FOLDER);
  const { downloads, transfers } = setup();
  const view = await transfers.create({
    source: `https://drive.google.com/drive/folders/${src.id}`,
    destination: dest.id,
    mode: 'copy'
  });
  const done = await waitFinished(transfers, view.id);
  assert.strictEqual(done.status, 'completed', done.error);
  const root = childByName(dest.id, 'CopySrc');
  assert.strictEqual(childByName(root.id, 'a.txt').data.toString(), 'A');
  assert.strictEqual(childByName(childByName(root.id, 'inner').id, 'b.txt').data.toString(), 'B');
  assert.strictEqual(downloads.list().length, 0, 'nothing downloaded');
  await transfers.shutdown();
  await downloads.shutdown();
});

test('destination must be a folder', async () => {
  const f = add('x.bin', null, Buffer.from('x'));
  const { downloads, transfers } = setup();
  await assert.rejects(
    transfers.create({ source: 'https://example.com/a.zip', destination: `https://drive.google.com/drive/folders/${f.id}`, mode: 'relay' }),
    /not a folder/
  );
  await transfers.shutdown();
  await downloads.shutdown();
});
