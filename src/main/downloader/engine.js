'use strict';

/**
 * Segmented, resumable HTTP download engine.
 *
 * - Probes the server for Range support and the total size.
 * - Splits the file into N segments downloaded over parallel connections and
 *   writes them in place into a pre-allocated "<name>.part" file.
 * - Dynamic segmentation (IDM-style): when a connection finishes its part it
 *   steals half of the largest remaining part, so all connections stay busy
 *   until the very end.
 * - Per-segment retries with backoff and stall detection.
 * - State (segments + positions) is serialisable so downloads survive an app
 *   restart and resume exactly where they stopped.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const {
  sanitizeFilename,
  uniquePath,
  filenameFromDisposition,
  filenameFromUrl,
  extFromMime,
  sleep,
  HttpError
} = require('../utils');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const MIN_SPLIT = 256 * 1024; // never create segments smaller than this
const WRITE_BUFFER = 512 * 1024;
const STALL_TIMEOUT = 45000;

// Paths chosen by in-flight downloads whose .part file may not exist yet.
const RESERVED = new Set();

function discard(res) {
  try {
    const p = res.body && res.body.cancel();
    if (p && p.catch) p.catch(() => {});
  } catch {}
}

class DownloadTask extends EventEmitter {
  /**
   * @param {object} state serialisable task state (see toJSON)
   * @param {object} opts  { limiter, getAuthHeaders(task), maxRetries, userAgent }
   */
  constructor(state, opts = {}) {
    super();
    this.opts = opts;
    state = { ...state };
    delete state.receivedBytes; // derived from segments
    Object.assign(
      this,
      {
        id: null,
        url: null,
        dir: null,
        filename: null, // user supplied or discovered
        savePath: null,
        totalBytes: -1,
        resumable: false,
        segments: [],
        connections: 8,
        status: 'queued',
        error: null,
        headers: {},
        auth: null,
        meta: {},
        transferId: null,
        mime: null,
        createdAt: Date.now(),
        finishedAt: null
      },
      state
    );
    this.speed = 0;
    this._controller = null;
    this._running = null;
    this._fh = null;
    this._lastBytes = this.receivedBytes;
    this._lastTick = Date.now();
  }

  get receivedBytes() {
    if (!this.segments.length) return this._streamBytes || 0;
    return this.segments.reduce((a, s) => a + (s.pos - s.start) + (s.buffered || 0), 0);
  }

  get tmpPath() {
    return this.savePath ? this.savePath + '.part' : null;
  }

  get active() {
    return this.status === 'connecting' || this.status === 'downloading';
  }

  toJSON() {
    return {
      id: this.id,
      url: this.url,
      dir: this.dir,
      filename: this.filename,
      savePath: this.savePath,
      totalBytes: this.totalBytes,
      receivedBytes: this.receivedBytes,
      resumable: this.resumable,
      segments: this.segments.map((s) => ({ start: s.start, end: s.end, pos: s.pos })),
      connections: this.connections,
      status: this.status,
      error: this.error,
      headers: this.headers,
      auth: this.auth,
      meta: this.meta,
      transferId: this.transferId,
      mime: this.mime,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt
    };
  }

  /** Snapshot for the UI. */
  view() {
    const j = this.toJSON();
    delete j.segments;
    delete j.headers;
    j.speed = this.speed;
    j.eta = this.speed > 0 && this.totalBytes > 0 ? (this.totalBytes - j.receivedBytes) / this.speed : null;
    j.activeConnections = this._activeWorkers || 0;
    return j;
  }

  /** Called by the manager every second to refresh the speed (EMA). */
  tick() {
    const now = Date.now();
    const bytes = this.receivedBytes;
    const dt = (now - this._lastTick) / 1000;
    if (dt > 0) {
      const inst = Math.max(0, bytes - this._lastBytes) / dt;
      this.speed = this.active ? (this.speed ? this.speed * 0.6 + inst * 0.4 : inst) : 0;
    }
    this._lastBytes = bytes;
    this._lastTick = now;
  }

  _setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.emit('status', this);
  }

  async _headers(extra = {}) {
    const auth = this.opts.getAuthHeaders ? await this.opts.getAuthHeaders(this) : {};
    return {
      'User-Agent': this.opts.userAgent || DEFAULT_UA,
      'Accept-Encoding': 'identity',
      Accept: '*/*',
      ...this.headers,
      ...auth,
      ...extra
    };
  }

  async _fetch(extraHeaders, signal) {
    const res = await fetch(this.url, {
      headers: await this._headers(extraHeaders),
      redirect: 'follow',
      signal
    });
    if (res.status === 401 && this.opts.onAuthError) {
      // Let the owner refresh credentials, then retry once.
      discard(res);
      await this.opts.onAuthError(this);
      return fetch(this.url, { headers: await this._headers(extraHeaders), redirect: 'follow', signal });
    }
    return res;
  }

  /** Start or resume. Resolves when the task stops (completed, paused, error). */
  start() {
    if (this._running) return this._running;
    this._running = this._run().finally(() => {
      this._running = null;
    });
    return this._running;
  }

  async _run() {
    this._controller = new AbortController();
    const signal = this._controller.signal;
    this._setStatus('connecting');
    try {
      if (!this.segments.length && !this._probed) await this._probe(signal);
      await this._prepareFile();
      this._setStatus('downloading');
      if (this.resumable) await this._downloadSegmented(signal);
      else await this._downloadStream(signal);
      await this._finish();
    } catch (err) {
      await this._closeFile();
      if (signal.aborted) {
        // pause() or cancel() set the status already.
        return;
      }
      this._setStatus('error', err.message || String(err));
    }
  }

  async _probe(signal) {
    const res = await this._fetch({ Range: 'bytes=0-0' }, signal);
    discard(res);
    if (res.status === 416) {
      this.totalBytes = 0;
      this.resumable = false;
    } else if (!res.ok) {
      throw new HttpError(res.status, `Server responded ${res.status} ${res.statusText}`);
    } else {
      const cr = res.headers.get('content-range');
      const m = cr && /\/(\d+)\s*$/.exec(cr);
      if (res.status === 206 && m) {
        this.totalBytes = Number(m[1]);
        this.resumable = this.totalBytes > 0;
      } else {
        const len = Number(res.headers.get('content-length'));
        this.totalBytes = Number.isFinite(len) && len > 0 ? len : -1;
        this.resumable = false;
      }
    }
    this.mime = res.headers.get('content-type');
    if (this.opts.onProbe) await this.opts.onProbe(this, res);
    if (!this.filename) {
      let name =
        filenameFromDisposition(res.headers.get('content-disposition')) ||
        filenameFromUrl(res.url) ||
        filenameFromUrl(this.url) ||
        'download';
      if (!path.extname(name)) name += extFromMime(this.mime);
      this.filename = name;
    }
    this.filename = sanitizeFilename(this.filename);
    if (!this.savePath) {
      await fsp.mkdir(this.dir, { recursive: true });
      this.savePath = uniquePath(path.join(this.dir, this.filename), RESERVED);
      RESERVED.add(this.savePath);
      this.filename = path.basename(this.savePath);
    }
    this._probed = true;
    if (this.resumable) this._initSegments();
    this.emit('status', this);
  }

  _initSegments() {
    const total = this.totalBytes;
    const n = Math.max(1, Math.min(this.connections, Math.floor(total / MIN_SPLIT) || 1));
    const size = Math.ceil(total / n);
    this.segments = [];
    for (let i = 0; i < n; i++) {
      const start = i * size;
      if (start >= total) break;
      const end = Math.min(total - 1, start + size - 1);
      this.segments.push({ start, end, pos: start });
    }
  }

  async _prepareFile() {
    await fsp.mkdir(path.dirname(this.savePath), { recursive: true });
    const exists = fs.existsSync(this.tmpPath);
    if (!this.resumable) {
      // Cannot resume a non-ranged stream: always restart from scratch.
      this._fh = await fsp.open(this.tmpPath, 'w');
      this._streamBytes = 0;
      return;
    }
    if (!exists) {
      // Lost the partial file: restart all segments.
      for (const s of this.segments) s.pos = s.start;
      this._fh = await fsp.open(this.tmpPath, 'w');
      if (this.totalBytes > 0) await this._fh.truncate(this.totalBytes);
    } else {
      this._fh = await fsp.open(this.tmpPath, 'r+');
    }
  }

  async _closeFile() {
    if (this._fh) {
      const fh = this._fh;
      this._fh = null;
      try {
        await fh.close();
      } catch {}
    }
  }

  async _write(buf, position) {
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await this._fh.write(buf, off, buf.length - off, position + off);
      off += bytesWritten;
    }
  }

  /* ------------------------- non-resumable stream ------------------------- */

  async _downloadStream(signal) {
    let attempt = 0;
    for (;;) {
      try {
        this._activeWorkers = 1;
        const local = new AbortController();
        signal.addEventListener('abort', () => local.abort(), { once: true });
        const res = await this._fetch({}, local.signal);
        if (!res.ok) throw new HttpError(res.status, `Server responded ${res.status}`);
        this._streamBytes = 0;
        let pos = 0;
        const stall = this._stallTimer(local);
        for await (const chunk of res.body) {
          stall.reset();
          const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          if (this.opts.limiter) await this.opts.limiter.consume(buf.length, signal);
          await this._write(buf, pos);
          pos += buf.length;
          this._streamBytes = pos;
        }
        stall.clear();
        if (this.totalBytes > 0 && pos < this.totalBytes) throw new Error('Connection closed early');
        if (this.totalBytes <= 0) this.totalBytes = pos;
        this._activeWorkers = 0;
        return;
      } catch (err) {
        this._activeWorkers = 0;
        if (signal.aborted) throw err;
        if (++attempt > (this.opts.maxRetries ?? 5) || (err.status && err.status < 500 && err.status !== 429))
          throw err;
        await sleep(Math.min(30000, 1000 * 2 ** attempt));
      }
    }
  }

  /* ---------------------------- segmented mode ---------------------------- */

  async _downloadSegmented(signal) {
    const busy = new Set();
    this._activeWorkers = 0;
    let fatal = null;

    const nextSegment = () => {
      // 1. an unfinished segment nobody is working on
      const free = this.segments.find((s) => s.pos <= s.end && !busy.has(s));
      if (free) return free;
      // 2. steal half of the biggest remaining segment
      let best = null;
      for (const s of busy) {
        const rem = s.end - s.pos + 1;
        if (rem > MIN_SPLIT * 2 && (!best || rem > best.end - best.pos + 1)) best = s;
      }
      if (!best) return null;
      const mid = best.pos + Math.floor((best.end - best.pos + 1) / 2);
      const seg = { start: mid, end: best.end, pos: mid };
      best.end = mid - 1;
      this.segments.push(seg);
      this.segments.sort((a, b) => a.start - b.start);
      return seg;
    };

    const worker = async () => {
      for (;;) {
        if (signal.aborted || fatal) return;
        const seg = nextSegment();
        if (!seg) return;
        busy.add(seg);
        this._activeWorkers++;
        try {
          await this._downloadSegment(seg, signal);
        } catch (err) {
          if (!signal.aborted) fatal = fatal || err;
        } finally {
          busy.delete(seg);
          this._activeWorkers--;
        }
      }
    };

    const n = Math.max(1, Math.min(this.connections, 32));
    await Promise.all(Array.from({ length: n }, worker));
    if (signal.aborted) throw new Error('aborted');
    if (fatal) throw fatal;
    const left = this.segments.find((s) => s.pos <= s.end);
    if (left) throw new Error('Download incomplete');
  }

  async _downloadSegment(seg, signal) {
    let failures = 0;
    while (seg.pos <= seg.end) {
      if (signal.aborted) throw new Error('aborted');
      const local = new AbortController();
      const onAbort = () => local.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const before = seg.pos;
      try {
        const res = await this._fetch({ Range: `bytes=${seg.pos}-${seg.end}` }, local.signal);
        if (res.status !== 206) {
          discard(res);
          if (res.status === 200) throw new Error('Server stopped honouring Range requests');
          throw new HttpError(res.status, `Server responded ${res.status} ${res.statusText}`);
        }
        await this._pump(res, seg, local, signal);
      } catch (err) {
        if (signal.aborted) throw err;
        if (seg.pos > seg.end) break; // finished (segment was shrunk by a split)
        if (seg.pos > before) failures = 0; // progress was made, reset the counter
        const status = err.status;
        const permanent = status && status >= 400 && status < 500 && ![408, 429, 403, 401].includes(status);
        if (permanent || ++failures > (this.opts.maxRetries ?? 6)) throw err;
        await sleep(Math.min(20000, 500 * 2 ** failures));
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  async _pump(res, seg, local, signal) {
    let buffer = [];
    let buffered = 0;
    const stall = this._stallTimer(local);
    const flush = async () => {
      if (!buffered) return;
      const buf = buffer.length === 1 ? buffer[0] : Buffer.concat(buffer, buffered);
      buffer = [];
      buffered = 0;
      seg.buffered = 0;
      await this._write(buf, seg.pos);
      seg.pos += buf.length;
    };
    try {
      for await (const chunk of res.body) {
        stall.reset();
        let buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        // seg.end may shrink at any moment because another worker stole the tail.
        const allowed = seg.end + 1 - (seg.pos + buffered);
        if (allowed <= 0) break;
        if (buf.length > allowed) buf = buf.subarray(0, allowed);
        if (this.opts.limiter) await this.opts.limiter.consume(buf.length, signal);
        buffer.push(buf);
        buffered += buf.length;
        seg.buffered = buffered;
        if (buffered >= WRITE_BUFFER) await flush();
        if (seg.pos + buffered > seg.end) break;
      }
    } finally {
      stall.clear();
      // Keep whatever arrived before a pause / network error.
      if (this._fh) await flush().catch(() => {});
      seg.buffered = 0;
      // Close the connection if we stopped early.
      if (seg.pos > seg.end) local.abort();
    }
    if (seg.pos <= seg.end) throw new Error('Connection closed early');
  }

  _stallTimer(controllerOrSignal) {
    let t = null;
    const abort = () => {
      if (controllerOrSignal.abort) controllerOrSignal.abort();
    };
    const api = {
      reset() {
        clearTimeout(t);
        t = setTimeout(abort, STALL_TIMEOUT);
      },
      clear() {
        clearTimeout(t);
      }
    };
    api.reset();
    return api;
  }

  async _finish() {
    await this._closeFile();
    if (this.totalBytes > 0) {
      const st = await fsp.stat(this.tmpPath);
      if (st.size !== this.totalBytes) throw new Error(`Size mismatch (${st.size} vs ${this.totalBytes})`);
    }
    let finalPath = this.savePath;
    if (fs.existsSync(finalPath)) finalPath = uniquePath(finalPath);
    await fsp.rename(this.tmpPath, finalPath);
    RESERVED.delete(this.savePath);
    this.savePath = finalPath;
    this.filename = path.basename(finalPath);
    if (this.totalBytes < 0) this.totalBytes = this.receivedBytes;
    this.finishedAt = Date.now();
    this.speed = 0;
    this._setStatus('completed');
  }

  async pause() {
    if (!this.active && this.status !== 'queued') return;
    this._setStatus('paused');
    if (this._controller) this._controller.abort();
    if (this._running) await this._running.catch(() => {});
    this.speed = 0;
  }

  async cancel(deleteFile = true) {
    const wasRunning = this._running;
    this._setStatus('canceled');
    if (this._controller) this._controller.abort();
    if (wasRunning) await wasRunning.catch(() => {});
    if (deleteFile && this.tmpPath) await fsp.rm(this.tmpPath, { force: true }).catch(() => {});
    RESERVED.delete(this.savePath);
    this.speed = 0;
  }
}

module.exports = { DownloadTask, DEFAULT_UA, discard };
