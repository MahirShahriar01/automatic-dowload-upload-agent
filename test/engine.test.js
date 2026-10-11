'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DownloadTask } = require('../src/main/downloader/engine');
const { DownloadManager } = require('../src/main/downloader/manager');
const { Limiter } = require('../src/main/downloader/limiter');

const DATA = crypto.randomBytes(5 * 1024 * 1024 + 123);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function startServer({ ranges = true, throttle = 0, failFirst = 0, slowStart = false } = {}) {
  let requests = 0;
  let failures = failFirst;
  const server = http.createServer((req, res) => {
    requests++;
    if (failures > 0 && req.headers.range && req.headers.range !== 'bytes=0-0') {
      failures--;
      res.writeHead(503);
      return res.end();
    }
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="file name.bin"' };
    let start = 0;
    let end = DATA.length - 1;
    const m = ranges && /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), end) : end;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${DATA.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': DATA.length });
    }
    const body = DATA.subarray(start, end + 1);
    if (!throttle) return res.end(body);
    // slowStart: the connection serving the head of the file is 8x slower.
    const step = slowStart && start === 0 ? throttle / 8 : throttle;
    let off = 0;
    const iv = setInterval(() => {
      if (off >= body.length || res.destroyed) {
        clearInterval(iv);
        return res.end();
      }
      res.write(body.subarray(off, off + step));
      off += step;
    }, 10);
    res.on('close', () => clearInterval(iv));
  });
  const close = server.close.bind(server);
  server.close = () => (close(), server.closeAllConnections());
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}/x/file.bin`, requests: () => requests }))
  );
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dr-test-'));

test('segmented download produces identical file', async () => {
  const { server, url } = await startServer();
  const dir = tmp();
  const t = new DownloadTask({ id: 't1', url, dir, connections: 8 });
  await t.start();
  server.close();
  assert.strictEqual(t.status, 'completed', t.error);
  assert.strictEqual(t.filename, 'file name.bin');
  assert.ok(t.segments.length >= 8);
  assert.strictEqual(sha(fs.readFileSync(t.savePath)), sha(DATA));
  assert.ok(!fs.existsSync(t.savePath + '.part'));
});

test('non-ranged server falls back to single stream', async () => {
  const { server, url } = await startServer({ ranges: false });
  const dir = tmp();
  const t = new DownloadTask({ id: 't2', url, dir, filename: 'plain.bin' });
  await t.start();
  server.close();
  assert.strictEqual(t.status, 'completed', t.error);
  assert.strictEqual(t.resumable, false);
  assert.strictEqual(sha(fs.readFileSync(t.savePath)), sha(DATA));
});

test('pause and resume (also across a new task instance)', async (tc) => {
  const { server, url } = await startServer({ throttle: 8 * 1024 });
  tc.after(() => server.close());
  const dir = tmp();
  const t = new DownloadTask({ id: 't3', url, dir, connections: 4 });
  const run = t.start();
  await new Promise((r) => setTimeout(r, 300));
  await t.pause();
  await run;
  assert.strictEqual(t.status, 'paused');
  const got = t.receivedBytes;
  assert.ok(got > 0 && got < DATA.length, `received ${got}`);
  // Simulate an app restart: rebuild from serialised state.
  const t2 = new DownloadTask(JSON.parse(JSON.stringify(t.toJSON())), {});
  t2.status = 'queued';
  await t2.start();
  server.close();
  assert.strictEqual(t2.status, 'completed', t2.error);
  assert.strictEqual(sha(fs.readFileSync(t2.savePath)), sha(DATA));
});

test('retries transient 503 errors', async () => {
  const { server, url } = await startServer({ failFirst: 5 });
  const dir = tmp();
  const t = new DownloadTask({ id: 't4', url, dir, connections: 4 }, { maxRetries: 6 });
  await t.start();
  server.close();
  assert.strictEqual(t.status, 'completed', t.error);
  assert.strictEqual(sha(fs.readFileSync(t.savePath)), sha(DATA));
});

test('dynamic segmentation splits work when a connection finishes', async () => {
  const { server, url } = await startServer({ throttle: 128 * 1024, slowStart: true });
  const dir = tmp();
  const t = new DownloadTask({ id: 't5', url, dir, connections: 3 });
  await t.start();
  server.close();
  assert.strictEqual(t.status, 'completed', t.error);
  assert.ok(t.segments.length > 3, `segments: ${t.segments.length}`);
  assert.strictEqual(sha(fs.readFileSync(t.savePath)), sha(DATA));
});

test('limiter caps throughput', async () => {
  const l = new Limiter(1024 * 1024);
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) await l.consume(128 * 1024);
  const dt = Date.now() - t0;
  assert.ok(dt >= 1300, `took ${dt}ms`);
});

test('manager queues and completes downloads', async () => {
  const { server, url } = await startServer();
  const dir = tmp();
  const store = { data: [], save() {}, flush() {} };
  const m = new DownloadManager({ store, settings: () => ({ maxConcurrent: 2, connections: 4, downloadDir: dir }) });
  const tasks = [m.add({ url }), m.add({ url }), m.add({ url })];
  await Promise.all(tasks.map((t) => m.waitFor(t.id)));
  await m.shutdown();
  server.close();
  const names = tasks.map((t) => path.basename(t.savePath)).sort();
  assert.deepStrictEqual(names, ['file name (1).bin', 'file name (2).bin', 'file name.bin']);
  for (const t of tasks) assert.strictEqual(sha(fs.readFileSync(t.savePath)), sha(DATA));
});
