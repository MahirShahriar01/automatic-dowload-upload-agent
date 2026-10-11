'use strict';

/**
 * Drive Relay jobs: source link -> local folder -> destination Drive folder.
 *
 * Modes
 *  - relay    : download every file (segmented, resumable) then upload it to the
 *               destination folder (resumable). Uploads start as soon as each
 *               file finishes downloading (pipelined).
 *  - download : download only (Drive folders are mirrored locally).
 *  - copy     : Drive -> Drive server-side copy. Nothing is downloaded.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const drive = require('./google/drive');
const { resolveDirectUrl } = require('./resolvers');
const { id, sanitizeFilename, sanitizeRelPath, AbortError } = require('./utils');

const MIME_BY_EXT = {
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.exe': 'application/x-msdownload',
  '.dmg': 'application/x-apple-diskimage',
  '.iso': 'application/x-iso9660-image'
};

/** Small promise semaphore. */
function semaphore(n) {
  let active = 0;
  const waiters = [];
  return async (fn) => {
    if (active >= n) await new Promise((r) => waiters.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };
}

function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortError());
    const onAbort = () => reject(new AbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => (signal.removeEventListener('abort', onAbort), resolve(v)),
      (e) => (signal.removeEventListener('abort', onAbort), reject(e))
    );
  });
}

async function md5File(file) {
  const h = crypto.createHash('md5');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) h.update(chunk);
  return h.digest('hex');
}

class TransferManager extends EventEmitter {
  /**
   * @param {object} o { store: JsonStore(array), downloads: DownloadManager, auth: GoogleAuth,
   *                     settings: () => settings, clientFactory?: (accountId) => DriveClient }
   */
  constructor(o) {
    super();
    this.o = o;
    this.store = o.store;
    this.downloads = o.downloads;
    this.auth = o.auth;
    this.jobs = new Map();
    this.running = new Map();
    for (const j of this.store.data) {
      if (['resolving', 'running'].includes(j.status)) j.status = 'queued';
      for (const it of j.items || []) if (it.state === 'uploading') it.state = 'downloaded';
      this.jobs.set(j.id, j);
    }
    this._timer = setInterval(() => this._tick(), 1000);
    setImmediate(() => {
      for (const j of this.jobs.values()) if (j.status === 'queued') this._run(j);
    });
  }

  _client(accountId) {
    if (this.o.clientFactory) return this.o.clientFactory(accountId);
    return new drive.DriveClient(this.auth, accountId);
  }

  _save() {
    this.store.data = [...this.jobs.values()];
    this.store.save();
  }

  _tick() {
    for (const jobId of this.running.keys()) {
      const j = this.jobs.get(jobId);
      if (j) this.emit('update', this.view(j));
    }
  }

  _emit(job) {
    this._save();
    this.emit('update', this.view(job));
  }

  /* ------------------------------ public API ------------------------------ */

  list() {
    return [...this.jobs.values()].map((j) => this.view(j));
  }

  get(jobId) {
    const j = this.jobs.get(jobId);
    return j ? this.view(j, true) : null;
  }

  view(job, withItems = false) {
    let totalBytes = 0;
    let downBytes = 0;
    let upBytes = 0;
    let speed = 0;
    const counts = { total: 0, done: 0, failed: 0, skipped: 0, active: 0 };
    const items = [];
    for (const it of job.items || []) {
      counts.total++;
      const task = it.downloadId ? this.downloads.get(it.downloadId) : null;
      const size = it.size > 0 ? it.size : task && task.totalBytes > 0 ? task.totalBytes : 0;
      let down = 0;
      if (['downloaded', 'uploading', 'uploaded', 'done'].includes(it.state)) down = size;
      else if (task) down = task.receivedBytes;
      if (task && task.active) speed += task.speed || 0;
      if (it.state === 'uploading') speed += it.uploadSpeed || 0;
      const up = it.state === 'done' && job.mode === 'relay' ? size : it.uploadedBytes || 0;
      totalBytes += size;
      downBytes += down;
      upBytes += up;
      if (it.state === 'done' || it.state === 'copied') counts.done++;
      else if (it.state === 'error') counts.failed++;
      else if (it.state === 'skipped') counts.skipped++;
      else if (['downloading', 'uploading', 'copying', 'verifying'].includes(it.state)) counts.active++;
      if (withItems) {
        items.push({
          key: it.key,
          name: it.name || (task && task.filename) || '(resolving name…)',
          relDir: it.relDir,
          size,
          state: it.state,
          error: it.error,
          downloaded: down,
          uploaded: up,
          downloadStatus: task ? task.status : null
        });
      }
    }
    let progress;
    if (job.mode === 'copy') progress = counts.total ? (counts.done + counts.skipped) / counts.total : 0;
    else if (job.mode === 'relay') progress = totalBytes ? (downBytes + upBytes) / (2 * totalBytes) : 0;
    else progress = totalBytes ? downBytes / totalBytes : 0;
    if (job.status === 'completed') progress = 1;
    const v = {
      id: job.id,
      title: job.title || job.source,
      source: job.source,
      destination: job.destination,
      destName: job.destName,
      localDir: job.localDir,
      rootLocal: job.rootName ? path.join(job.localDir, sanitizeFilename(job.rootName)) : job.localDir,
      mode: job.mode,
      keepLocal: job.keepLocal,
      status: job.status,
      error: job.error,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      phase: job.phase,
      counts,
      totalBytes,
      downBytes,
      upBytes,
      speed,
      progress
    };
    if (withItems) v.items = items;
    return v;
  }

  /**
   * @param {object} o { source, destination?, localDir, mode, keepLocal, sourceAccount, destAccount,
   *                     createRootFolder=true, skipExisting=true, verify=true }
   */
  async create(o) {
    const s = this.o.settings();
    const source = String(o.source || '').trim();
    if (!source) throw new Error('Paste a source link first.');
    const mode = o.mode || (o.destination ? 'relay' : 'download');
    const job = {
      id: id('t_'),
      source,
      destination: (o.destination || '').trim() || null,
      localDir: o.localDir || s.downloadDir,
      mode,
      keepLocal: o.keepLocal !== false,
      sourceAccount: o.sourceAccount || 'auto',
      destAccount: o.destAccount || this.auth.defaultAccountId(),
      createRootFolder: o.createRootFolder !== false,
      skipExisting: o.skipExisting !== false,
      verify: o.verify !== false,
      status: 'queued',
      error: null,
      items: [],
      createdAt: Date.now(),
      finishedAt: null
    };
    if (mode !== 'download') {
      if (!job.destination) throw new Error('Paste the destination Google Drive folder link.');
      if (!job.destAccount) throw new Error('Sign in with the Google account that owns the destination folder (Accounts page).');
      const link = drive.parseDriveLink(job.destination);
      if (!link || link.kind === 'file') throw new Error('The destination must be a Google Drive folder link.');
      const folder = await this._client(job.destAccount).getFile(link.id, link.resourceKey).catch((e) => {
        throw new Error(`Cannot open destination folder with ${job.destAccount}: ${e.message}`);
      });
      if (folder.mimeType !== drive.FOLDER_MIME) throw new Error('The destination link points to a file, not a folder.');
      if (folder.capabilities && folder.capabilities.canAddChildren === false)
        throw new Error(`${job.destAccount} does not have permission to add files to "${folder.name}".`);
      job.destFolderId = folder.id;
      job.destName = folder.name;
    }
    if (mode === 'copy' && !drive.parseDriveLink(source)) throw new Error('Cloud copy only works when the source is a Google Drive link.');
    this.jobs.set(job.id, job);
    this._emit(job);
    this._run(job);
    return this.view(job);
  }

  async pause(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const ctx = this.running.get(jobId);
    job.status = 'paused';
    if (ctx) ctx.controller.abort();
    for (const it of job.items) if (it.downloadId) await this.downloads.pause(it.downloadId);
    if (ctx) await ctx.done.catch(() => {});
    this._emit(job);
  }

  resume(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || this.running.has(jobId) || job.status === 'completed') return;
    job.status = 'queued';
    job.error = null;
    this._run(job);
  }

  async retryFailed(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || this.running.has(jobId)) return;
    for (const it of job.items) {
      if (it.state !== 'error') continue;
      if (it.downloadId) {
        const t = this.downloads.get(it.downloadId);
        // Expired / failed links are re-resolved from scratch.
        if (t && t.status === 'error') await this.downloads.remove(it.downloadId);
        if (!t || t.status !== 'completed') it.downloadId = null;
      }
      it.state = it.localPath && fs.existsSync(it.localPath) ? 'downloaded' : 'pending';
      it.error = null;
    }
    job.status = 'queued';
    job.error = null;
    this._run(job);
  }

  async cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    await this.pause(jobId);
    job.status = 'canceled';
    for (const it of job.items) {
      if (it.downloadId) {
        const t = this.downloads.get(it.downloadId);
        if (t && t.status !== 'completed') await this.downloads.remove(it.downloadId);
      }
    }
    this._emit(job);
  }

  async remove(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (this.running.has(jobId)) await this.cancel(jobId);
    this.jobs.delete(jobId);
    this._save();
    this.emit('removed', jobId);
  }

  async shutdown() {
    clearInterval(this._timer);
    for (const [jobId, ctx] of this.running) {
      const job = this.jobs.get(jobId);
      ctx.controller.abort();
      await ctx.done.catch(() => {});
      if (job) job.status = 'queued'; // resume on next launch
    }
    this._save();
    this.store.flush();
  }

  /* ------------------------------- runner -------------------------------- */

  _run(job) {
    if (this.running.has(job.id)) return;
    const ctx = { controller: new AbortController(), folders: new Map() };
    ctx.signal = ctx.controller.signal;
    this.running.set(job.id, ctx);
    ctx.done = this._runInner(job, ctx).finally(() => {
      this.running.delete(job.id);
      this._emit(job);
    });
  }

  async _runInner(job, ctx) {
    try {
      job.status = 'resolving';
      job.phase = 'Reading source…';
      this._emit(job);
      if (!job.items.length) await this._resolve(job, ctx);
      job.status = 'running';
      job.phase = null;
      this._emit(job);
      if (job.mode === 'copy') await this._runCopy(job, ctx);
      else await this._runRelay(job, ctx);
      if (ctx.signal.aborted) return;
      const failed = job.items.filter((i) => i.state === 'error').length;
      job.status = failed ? 'error' : 'completed';
      job.error = failed ? `${failed} of ${job.items.length} file(s) failed — use "Retry failed"` : null;
      job.finishedAt = Date.now();
      this.emit('finished', this.view(job));
    } catch (e) {
      if (ctx.signal.aborted || e.name === 'AbortError') return;
      job.status = 'error';
      job.error = e.message || String(e);
      job.phase = null;
      this.emit('finished', this.view(job));
    }
  }

  _sourceAccountCandidates(job) {
    if (job.sourceAccount === 'public') return [];
    const list = [];
    if (job.sourceAccount && job.sourceAccount !== 'auto') list.push(job.sourceAccount);
    else {
      if (job.destAccount) list.push(job.destAccount);
      for (const a of this.auth.accounts()) if (!list.includes(a.id)) list.push(a.id);
    }
    return list.filter((a) => this.auth.hasAccount(a));
  }

  _fileItem(f, relDir) {
    const ex = drive.exportInfo(f.mimeType);
    if (f.mimeType && f.mimeType.startsWith('application/vnd.google-apps.') && !ex) {
      return { key: f.id, driveId: f.id, name: f.name, relDir, state: 'skipped', error: 'Google Forms/Sites/Maps cannot be downloaded', size: 0 };
    }
    let name = f.name;
    if (ex && !name.toLowerCase().endsWith(ex.ext)) name += ex.ext;
    return {
      key: f.id,
      driveId: f.id,
      resourceKey: f.resourceKey,
      name,
      origName: f.name,
      relDir: relDir || '',
      mimeType: ex ? ex.mime : f.mimeType,
      native: !!ex,
      size: ex ? -1 : Number(f.size ?? -1),
      md5: f.md5Checksum || null,
      state: 'pending'
    };
  }

  async _resolve(job, ctx) {
    const link = drive.parseDriveLink(job.source);
    if (!link) {
      job.sourceType = 'url';
      const r = await resolveDirectUrl(job.source);
      job.title = r.name || job.source;
      job.items = [{ key: 'url', url: r.url, name: r.name || null, relDir: '', size: -1, state: 'pending' }];
      return;
    }
    job.sourceType = 'drive';
    let lastErr = null;
    for (const accountId of this._sourceAccountCandidates(job)) {
      try {
        const client = this._client(accountId);
        const f = await client.getFile(link.id, link.resourceKey);
        job.resolvedAccount = accountId;
        if (f.mimeType === drive.FOLDER_MIME) {
          job.rootName = f.name;
          job.title = f.name;
          job.phase = `Listing folder "${f.name}"…`;
          this._emit(job);
          const files = await abortable(client.walk(f.id), ctx.signal);
          job.items = files.map((x) => this._fileItem(x, x.relDir));
          if (!job.items.length) throw new Error('The source folder is empty.');
        } else {
          job.title = f.name;
          job.items = [this._fileItem({ ...f, resourceKey: link.resourceKey }, '')];
        }
        return;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastErr = e;
        if (e.status && ![403, 404].includes(e.status)) throw e;
      }
    }
    if (job.mode === 'copy') {
      throw lastErr || new Error('Cloud copy needs a signed-in Google account that can read the source.');
    }
    // Public access (no account or account has no access).
    job.resolvedAccount = null;
    if (link.kind === 'folder' || link.kind === 'unknown') {
      try {
        const info = await drive.listPublicFolder(link.id, link.resourceKey);
        if (info.items.length || link.kind === 'folder') {
          job.rootName = info.name;
          job.title = info.name;
          job.phase = `Listing folder "${info.name}"…`;
          this._emit(job);
          const files = await drive.walkPublicFolder(link.id, link.resourceKey);
          job.items = files.map((x) => ({ key: x.id, driveId: x.id, name: x.name, relDir: x.relDir, size: -1, state: 'pending' }));
          if (!job.items.length) throw new Error('The folder is empty or not shared publicly.');
          return;
        }
      } catch (e) {
        if (link.kind === 'folder') throw lastErr && lastErr.status === 403 ? lastErr : e;
      }
    }
    const r = await drive.resolvePublicFile(link.id, link.resourceKey);
    job.title = r.name || job.source;
    job.items = [{ key: link.id, driveId: link.id, resourceKey: link.resourceKey, name: r.name || null, relDir: '', size: -1, state: 'pending', publicUrl: r.url }];
  }

  async _runRelay(job, ctx) {
    const s = this.o.settings();
    const downloadSlot = semaphore(Math.max(1, s.maxConcurrent || 3));
    const uploadSlot = semaphore(Math.max(1, s.uploadConcurrency || 2));
    await Promise.all(
      job.items.map(async (item) => {
        if (['done', 'skipped'].includes(item.state)) return;
        try {
          if (item.state !== 'uploaded') {
            if (!(item.state === 'downloaded' && item.localPath && fs.existsSync(item.localPath))) {
              await downloadSlot(() => this._download(job, item, ctx));
            }
            if (ctx.signal.aborted) return;
            if (job.mode === 'relay') await uploadSlot(() => this._upload(job, item, ctx));
          }
          if (job.mode === 'relay') {
            if (!job.keepLocal && item.localPath) {
              await fsp.rm(item.localPath, { force: true }).catch(() => {});
              if (item.downloadId) await this.downloads.remove(item.downloadId).catch(() => {});
            }
          }
          item.state = 'done';
          item.error = null;
          this._emit(job);
        } catch (e) {
          if (ctx.signal.aborted || e.name === 'AbortError') return;
          item.state = 'error';
          item.error = e.message || String(e);
          this._emit(job);
        }
      })
    );
    if (!job.keepLocal && job.mode === 'relay' && job.rootName) {
      // Remove now-empty mirrored folders.
      await removeEmptyDirs(path.join(job.localDir, sanitizeFilename(job.rootName))).catch(() => {});
    }
  }

  _localTarget(job, item) {
    const base = job.rootName ? path.join(job.localDir, sanitizeFilename(job.rootName)) : job.localDir;
    return path.join(base, sanitizeRelPath(item.relDir || ''));
  }

  async _download(job, item, ctx) {
    if (ctx.signal.aborted) throw new AbortError();
    let task = item.downloadId ? this.downloads.get(item.downloadId) : null;
    if (task && task.status === 'completed' && fs.existsSync(task.savePath)) {
      item.localPath = task.savePath;
      item.state = 'downloaded';
      return;
    }
    if (task && task.status === 'canceled') task = null;
    if (!task) {
      const dir = this._localTarget(job, item);
      if (job.skipExisting && item.name && item.size > 0) {
        const existing = path.join(dir, sanitizeFilename(item.name));
        const st = await fsp.stat(existing).catch(() => null);
        if (st && st.size === item.size) {
          item.localPath = existing;
          item.state = 'downloaded';
          this._emit(job);
          return;
        }
      }
      let url;
      let auth = null;
      let name = item.name;
      if (item.driveId && job.resolvedAccount) {
        url = drive.apiDownloadUrl({ id: item.driveId, mimeType: item.native ? findNative(item.mimeType) : item.mimeType });
        auth = { type: 'google', accountId: job.resolvedAccount };
      } else if (item.driveId) {
        const r = item.publicUrl ? { url: item.publicUrl } : await drive.resolvePublicFile(item.driveId, item.resourceKey);
        url = r.url;
        name = name || r.name || null;
        item.publicUrl = null; // single-use; re-resolve next time
      } else {
        url = item.url;
      }
      task = this.downloads.add({
        url,
        dir,
        filename: name,
        auth,
        size: item.size,
        transferId: job.id,
        meta: { transfer: job.title }
      });
      item.downloadId = task.id;
    } else if (['paused', 'error', 'queued'].includes(task.status)) {
      this.downloads.resume(task.id);
    }
    item.state = 'downloading';
    item.error = null;
    this._emit(job);
    await abortable(this.downloads.waitFor(task.id), ctx.signal);
    item.localPath = task.savePath;
    if (!item.name) item.name = task.filename;
    if (job.verify && item.md5) {
      item.state = 'verifying';
      this._emit(job);
      const sum = await md5File(item.localPath);
      if (sum !== item.md5) {
        await fsp.rm(item.localPath, { force: true }).catch(() => {});
        await this.downloads.remove(task.id).catch(() => {});
        item.downloadId = null;
        throw new Error('Checksum mismatch after download (file corrupted) — retry');
      }
    }
    item.state = 'downloaded';
    this._emit(job);
  }

  async _destFolder(job, relDir, ctx) {
    const client = this._client(job.destAccount);
    const parts = [];
    if (job.rootName && job.createRootFolder) parts.push(job.rootName);
    for (const p of String(relDir || '').split('/').filter(Boolean)) parts.push(p);
    let parent = job.destFolderId;
    let key = '';
    for (const name of parts) {
      key += '/' + name;
      if (!ctx.folders.has(key)) {
        const p = parent;
        ctx.folders.set(key, client.ensureFolder(name, p).then((f) => f.id));
      }
      try {
        parent = await ctx.folders.get(key);
      } catch (e) {
        ctx.folders.delete(key);
        throw e;
      }
    }
    return parent;
  }

  async _upload(job, item, ctx) {
    if (ctx.signal.aborted) throw new AbortError();
    const client = this._client(job.destAccount);
    const parentId = await this._destFolder(job, item.relDir, ctx);
    const name = item.name || path.basename(item.localPath);
    const size = (await fsp.stat(item.localPath)).size;
    if (job.skipExisting && !item.uploadSession) {
      const existing = await client.findChild(parentId, name, false).catch(() => null);
      if (existing && Number(existing.size) === size) {
        item.remoteId = existing.id;
        item.uploadedBytes = size;
        item.state = 'uploaded';
        return;
      }
    }
    item.state = 'uploading';
    item.uploadedBytes = 0;
    this._emit(job);
    let lastBytes = 0;
    let lastT = Date.now();
    const file = await client.upload({
      filePath: item.localPath,
      name,
      parentId,
      mimeType: item.mimeType && !item.mimeType.startsWith('application/vnd.google-apps') ? item.mimeType : MIME_BY_EXT[path.extname(name).toLowerCase()],
      signal: ctx.signal,
      sessionUri: item.uploadSession,
      onSession: (uri) => {
        item.uploadSession = uri;
        this._save();
      },
      onProgress: (bytes) => {
        item.uploadedBytes = bytes;
        const now = Date.now();
        if (now - lastT >= 1000) {
          const inst = ((bytes - lastBytes) * 1000) / (now - lastT);
          item.uploadSpeed = item.uploadSpeed ? item.uploadSpeed * 0.6 + inst * 0.4 : inst;
          lastBytes = bytes;
          lastT = now;
        }
      }
    });
    item.remoteId = file && file.id;
    item.uploadSession = null;
    item.uploadSpeed = 0;
    item.uploadedBytes = size;
    item.state = 'uploaded';
  }

  async _runCopy(job, ctx) {
    const client = this._client(job.destAccount);
    const slot = semaphore(4);
    await Promise.all(
      job.items.map((item) =>
        slot(async () => {
          if (['done', 'copied', 'skipped'].includes(item.state) || ctx.signal.aborted) return;
          try {
            const parentId = await this._destFolder(job, item.relDir, ctx);
            const name = item.origName || item.name;
            if (job.skipExisting) {
              const ex = await client.findChild(parentId, name, false).catch(() => null);
              if (ex && (item.size <= 0 || Number(ex.size) === item.size)) {
                item.state = 'done';
                this._emit(job);
                return;
              }
            }
            item.state = 'copying';
            this._emit(job);
            const r = await client.copyFile(item.driveId, { name, parentId, resourceKey: item.resourceKey });
            item.remoteId = r.id;
            item.state = 'done';
            item.error = null;
          } catch (e) {
            if (ctx.signal.aborted) return;
            item.state = 'error';
            item.error = e.reason === 'cannotCopyFile' ? 'The owner disabled copying for this file' : e.message;
          }
          this._emit(job);
        })
      )
    );
  }
}

function findNative(exportMime) {
  // Map an export MIME back to the Google-native type (needed for the export URL).
  const map = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'application/vnd.google-apps.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'application/vnd.google-apps.spreadsheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'application/vnd.google-apps.presentation',
    'image/png': 'application/vnd.google-apps.drawing',
    'application/vnd.google-apps.script+json': 'application/vnd.google-apps.script',
    'application/pdf': 'application/vnd.google-apps.jam'
  };
  return map[exportMime] || exportMime;
}

async function removeEmptyDirs(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  for (const e of entries) if (e.isDirectory()) await removeEmptyDirs(path.join(dir, e.name));
  const left = await fsp.readdir(dir).catch(() => ['x']);
  if (!left.length) await fsp.rmdir(dir).catch(() => {});
}

module.exports = { TransferManager, semaphore };
