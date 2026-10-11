'use strict';

/**
 * Google Drive helpers:
 *  - parse every common Drive / Docs link format
 *  - Drive API v3 client (metadata, recursive folder listing, folder creation,
 *    server-side copy, resumable chunked upload with progress + resume)
 *  - public (no sign-in) access: direct-download URL resolution including the
 *    "can't scan for viruses" confirmation page, and public folder listing.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { sleep, HttpError, AbortError } = require('../utils');

// The base can be overridden for the automated tests (mock Drive server).
const GOOGLE_API = process.env.DRIVERELAY_GOOGLE_API || 'https://www.googleapis.com';
const API = `${GOOGLE_API}/drive/v3`;
const UPLOAD_API = `${GOOGLE_API}/upload/drive/v3`;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const UPLOAD_CHUNK = Number(process.env.DRIVERELAY_UPLOAD_CHUNK) || 16 * 1024 * 1024; // multiple of 256 KiB

/** Google-native files cannot be downloaded directly; export them instead. */
const EXPORTS = {
  'application/vnd.google-apps.document': {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: '.docx'
  },
  'application/vnd.google-apps.spreadsheet': {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: '.xlsx'
  },
  'application/vnd.google-apps.presentation': {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: '.pptx'
  },
  'application/vnd.google-apps.drawing': { mime: 'image/png', ext: '.png' },
  'application/vnd.google-apps.script': { mime: 'application/vnd.google-apps.script+json', ext: '.json' },
  'application/vnd.google-apps.jam': { mime: 'application/pdf', ext: '.pdf' }
};

const ID_RE = /^[-\w]{20,}$/;

/**
 * Parse a Google Drive / Docs URL (or bare ID).
 * @returns {{kind:'file'|'folder'|'unknown', id:string, resourceKey?:string}|null}
 */
function parseDriveLink(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (ID_RE.test(s)) return { kind: 'unknown', id: s };
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!/(^|\.)(drive|docs|drive\.usercontent)\.google\.com$/.test(host) && host !== 'drive.usercontent.google.com') {
    return null;
  }
  const resourceKey = u.searchParams.get('resourcekey') || undefined;
  const p = u.pathname;
  let m;
  if ((m = /\/folders\/([-\w]+)/.exec(p))) return { kind: 'folder', id: m[1], resourceKey };
  if ((m = /\/file\/(?:u\/\d+\/)?d\/([-\w]+)/.exec(p))) return { kind: 'file', id: m[1], resourceKey };
  if ((m = /\/(?:document|spreadsheets|presentation|drawings|forms)\/(?:u\/\d+\/)?d\/([-\w]+)/.exec(p)))
    return { kind: 'file', id: m[1], resourceKey };
  if (/\/(embedded)?folderview/.test(p) && u.searchParams.get('id'))
    return { kind: 'folder', id: u.searchParams.get('id'), resourceKey };
  if (u.searchParams.get('id'))
    return { kind: /\/(uc|download)/.test(p) ? 'file' : 'unknown', id: u.searchParams.get('id'), resourceKey };
  if ((m = /\/d\/([-\w]{20,})/.exec(p))) return { kind: 'file', id: m[1], resourceKey };
  return null;
}

function isDriveLink(s) {
  return !!parseDriveLink(s) && !ID_RE.test(String(s).trim());
}

function exportInfo(mimeType) {
  return EXPORTS[mimeType] || null;
}

function apiDownloadUrl(file) {
  const ex = exportInfo(file.mimeType);
  if (ex) return `${API}/files/${file.id}/export?mimeType=${encodeURIComponent(ex.mime)}`;
  return `${API}/files/${file.id}?alt=media&acknowledgeAbuse=true&supportsAllDrives=true`;
}

function publicDownloadUrl(id, resourceKey) {
  let u = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
  if (resourceKey) u += `&resourcekey=${encodeURIComponent(resourceKey)}`;
  return u;
}

const decodeHtml = (s) =>
  String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u003d/g, '=')
    .replace(/\\u0026/g, '&');

/**
 * Parse Google's "can't scan this file for viruses" interstitial and build the
 * real download URL from its hidden form. Returns null if it is not that page.
 */
function parseConfirmPage(html) {
  const form = /<form[^>]+id="download-form"[^>]+action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) return null;
  const action = new URL(decodeHtml(form[1]), 'https://drive.usercontent.google.com');
  const inputRe = /<input[^>]+type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi;
  let m;
  while ((m = inputRe.exec(form[2]))) action.searchParams.set(m[1], decodeHtml(m[2]));
  const nameM = /<span class="uc-name-size"><a[^>]*>([^<]+)<\/a>/i.exec(html);
  return { url: action.toString(), name: nameM ? decodeHtml(nameM[1]) : undefined };
}

/**
 * Resolve a public Drive file to a URL that streams the actual bytes.
 * Handles the large-file "virus scan warning" page.
 * @returns {Promise<{url:string, name?:string, size?:number}>}
 */
async function resolvePublicFile(id, resourceKey) {
  const url = publicDownloadUrl(id, resourceKey);
  const res = await fetch(url, { headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' }, redirect: 'follow' });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('text/html')) {
    try {
      res.body?.cancel()?.catch(() => {});
    } catch {}
    if (res.status === 404) throw new Error('File not found or not shared publicly. Sign in with a Google account that can access it.');
    return { url };
  }
  const html = await res.text();
  const confirmed = parseConfirmPage(html);
  if (confirmed) return confirmed;
  if (/quota|too many users/i.test(html)) {
    throw new Error('Google Drive download quota exceeded for this file. Try later, or sign in and use "Cloud copy" mode.');
  }
  if (/ServiceLogin|accounts\.google\.com/i.test(html) || res.status === 403 || res.status === 401) {
    throw new Error('This file is private. Sign in with a Google account that has access to it.');
  }
  throw new Error('Google Drive returned a web page instead of the file. The file may be private or removed.');
}

/**
 * List a *public* folder without an account by scraping the embedded folder view.
 * @returns {Promise<{name:string, items:Array<{id,name,kind}>}>}
 */
async function listPublicFolder(id, resourceKey) {
  let u = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`;
  if (resourceKey) u += `&resourcekey=${encodeURIComponent(resourceKey)}`;
  const res = await fetch(u, { headers: { 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error('Folder not found or not public. Sign in with a Google account that can access it.');
  const html = await res.text();
  const title = /<title>([^<]*)<\/title>/i.exec(html);
  const items = [];
  const entryRe = /<div class="flip-entry" id="entry-([-\w]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;
  let m;
  while ((m = entryRe.exec(html))) {
    const href = decodeHtml(m[2]);
    items.push({ id: m[1], name: decodeHtml(m[3]).trim(), kind: /\/folders\//.test(href) ? 'folder' : 'file' });
  }
  if (!items.length && /ServiceLogin/.test(html)) throw new Error('Folder is private. Sign in with a Google account that can access it.');
  return { name: title ? decodeHtml(title[1]).trim() : id, items };
}

async function walkPublicFolder(id, resourceKey, rel = '', out = [], depth = 0) {
  if (depth > 30) return out;
  const { items } = await listPublicFolder(id, resourceKey);
  for (const it of items) {
    if (it.kind === 'folder') await walkPublicFolder(it.id, undefined, path.posix.join(rel, it.name), out, depth + 1);
    else out.push({ id: it.id, name: it.name, relDir: rel });
  }
  return out;
}

/* ------------------------------------------------------------------------ */

class DriveClient {
  /** @param {GoogleAuth} auth  @param {string} accountId */
  constructor(auth, accountId) {
    this.auth = auth;
    this.accountId = accountId;
  }

  async token(force) {
    return this.auth.getAccessToken(this.accountId, force);
  }

  async request(method, url, { query, json, body, headers = {}, raw = false, signal } = {}) {
    const full = new URL(url.startsWith('http') ? url : API + url);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) full.searchParams.set(k, v);
    let attempt = 0;
    let forceRefresh = false;
    for (;;) {
      const h = { Authorization: `Bearer ${await this.token(forceRefresh)}`, ...headers };
      if (json !== undefined) h['Content-Type'] = 'application/json; charset=UTF-8';
      let res;
      try {
        res = await fetch(full, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body, signal });
      } catch (e) {
        if (signal?.aborted) throw new AbortError();
        // Only network failures are retried; anything else is a real bug.
        if (!(e instanceof TypeError) || ++attempt > 5) throw e;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 && !forceRefresh) {
        forceRefresh = true;
        continue;
      }
      if (res.ok || (raw && res.status < 500 && res.status !== 429 && res.status !== 403)) {
        if (raw) return res;
        if (res.status === 204) return null;
        return res.json();
      }
      const text = await res.text().catch(() => '');
      let reason = '';
      let message = text;
      try {
        const j = JSON.parse(text);
        reason = j.error?.errors?.[0]?.reason || j.error?.status || '';
        message = j.error?.message || text;
      } catch {}
      const retriable =
        res.status >= 500 || res.status === 429 || /rateLimitExceeded|userRateLimitExceeded|backendError/.test(reason);
      if (retriable && ++attempt <= 6) {
        await sleep(Math.min(32000, 1000 * 2 ** attempt + Math.random() * 1000));
        continue;
      }
      const err = new HttpError(res.status, `Drive API: ${message || res.statusText}`.slice(0, 400));
      err.reason = reason;
      throw err;
    }
  }

  getFile(id, resourceKey) {
    const headers = resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${id}/${resourceKey}` } : {};
    return this.request('GET', `/files/${id}`, {
      query: {
        fields: 'id,name,mimeType,size,md5Checksum,parents,shortcutDetails,capabilities/canAddChildren,driveId',
        supportsAllDrives: true
      },
      headers
    });
  }

  async listChildren(folderId) {
    const out = [];
    let pageToken;
    do {
      const r = await this.request('GET', '/files', {
        query: {
          q: `'${folderId}' in parents and trashed = false`,
          fields: 'nextPageToken,files(id,name,mimeType,size,md5Checksum,shortcutDetails)',
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          pageToken
        }
      });
      out.push(...r.files);
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  /** Recursively list every file under a folder: [{...file, relDir}] */
  async walk(folderId, rel = '', out = [], seen = new Set()) {
    if (seen.has(folderId)) return out;
    seen.add(folderId);
    for (let f of await this.listChildren(folderId)) {
      if (f.mimeType === SHORTCUT_MIME && f.shortcutDetails?.targetId) {
        try {
          const target = await this.getFile(f.shortcutDetails.targetId);
          f = { ...target, name: f.name };
        } catch {
          continue;
        }
      }
      if (f.mimeType === FOLDER_MIME) await this.walk(f.id, path.posix.join(rel, f.name), out, seen);
      else out.push({ ...f, relDir: rel });
    }
    return out;
  }

  async findChild(parentId, name, folder) {
    const q = [`'${parentId}' in parents`, 'trashed = false', `name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`];
    if (folder === true) q.push(`mimeType = '${FOLDER_MIME}'`);
    if (folder === false) q.push(`mimeType != '${FOLDER_MIME}'`);
    const r = await this.request('GET', '/files', {
      query: {
        q: q.join(' and '),
        fields: 'files(id,name,mimeType,size,md5Checksum)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageSize: 10
      }
    });
    return r.files[0] || null;
  }

  async createFolder(name, parentId) {
    return this.request('POST', '/files', {
      query: { supportsAllDrives: true, fields: 'id,name' },
      json: { name, mimeType: FOLDER_MIME, parents: [parentId] }
    });
  }

  /** Find-or-create a folder with this name inside parentId. */
  async ensureFolder(name, parentId) {
    return (await this.findChild(parentId, name, true)) || this.createFolder(name, parentId);
  }

  async copyFile(id, { name, parentId, resourceKey }) {
    const headers = resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${id}/${resourceKey}` } : {};
    return this.request('POST', `/files/${id}/copy`, {
      query: { supportsAllDrives: true, fields: 'id,name,size,webViewLink' },
      json: { name, parents: parentId ? [parentId] : undefined },
      headers
    });
  }

  async deleteFile(id) {
    return this.request('DELETE', `/files/${id}`, { query: { supportsAllDrives: true } });
  }

  /**
   * Resumable upload of a local file.
   * @param {object} o { filePath, name, parentId, mimeType, signal, onProgress(bytes,total),
   *                     sessionUri, onSession(uri) }
   */
  async upload(o) {
    const size = (await fs.promises.stat(o.filePath)).size;
    const mime = o.mimeType || 'application/octet-stream';
    if (size === 0) {
      // Resumable sessions cannot carry an empty body; use a multipart upload.
      const boundary = 'driverelay' + Date.now();
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name: o.name, parents: [o.parentId] }) +
        `\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n\r\n--${boundary}--`;
      const file = await this.request('POST', `${UPLOAD_API}/files`, {
        query: { uploadType: 'multipart', supportsAllDrives: true, fields: 'id,name,size,webViewLink' },
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
        signal: o.signal
      });
      o.onProgress?.(0, 0);
      return file;
    }

    let uri = o.sessionUri;
    let offset = 0;
    if (uri) {
      const st = await this._queryOffset(uri, size, o.signal).catch(() => null);
      if (st === null) uri = null;
      else if (st.done) return st.file;
      else offset = st.offset;
    }
    if (!uri) {
      const res = await this.request('POST', `${UPLOAD_API}/files`, {
        query: { uploadType: 'resumable', supportsAllDrives: true, fields: 'id,name,size,webViewLink,md5Checksum' },
        headers: { 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size) },
        json: { name: o.name, parents: [o.parentId] },
        raw: true,
        signal: o.signal
      });
      if (!res.ok) throw new HttpError(res.status, `Could not start upload (${res.status}): ${await res.text()}`);
      uri = res.headers.get('location');
      offset = 0;
      if (o.onSession) o.onSession(uri);
    }
    o.onProgress?.(offset, size);

    let failures = 0;
    while (offset < size) {
      if (o.signal?.aborted) throw new AbortError();
      const end = Math.min(size, offset + UPLOAD_CHUNK) - 1;
      let r;
      try {
        r = await this._putChunk(uri, o.filePath, offset, end, size, o.signal, (n) => o.onProgress?.(offset + n, size));
      } catch (e) {
        if (o.signal?.aborted) throw new AbortError();
        if (++failures > 8) throw e;
        await sleep(Math.min(30000, 1000 * 2 ** failures));
        const st = await this._queryOffset(uri, size, o.signal).catch(() => null);
        if (st?.done) return st.file;
        if (st) offset = st.offset;
        continue;
      }
      if (r.status === 200 || r.status === 201) {
        o.onProgress?.(size, size);
        return JSON.parse(r.body || '{}');
      }
      if (r.status === 308) {
        failures = 0;
        const range = r.headers.range;
        offset = range ? Number(/bytes=0-(\d+)/.exec(range)[1]) + 1 : 0;
        o.onProgress?.(offset, size);
        continue;
      }
      if (r.status === 404 || r.status === 410) {
        // Session expired: start a new one.
        if (o.onSession) o.onSession(null);
        return this.upload({ ...o, sessionUri: null });
      }
      if (r.status === 401) {
        await this.token(true);
        continue;
      }
      if ((r.status >= 500 || r.status === 429 || r.status === 403) && ++failures <= 8) {
        await sleep(Math.min(30000, 1000 * 2 ** failures));
        const st = await this._queryOffset(uri, size, o.signal).catch(() => null);
        if (st?.done) return st.file;
        if (st) offset = st.offset;
        continue;
      }
      throw new HttpError(r.status, `Upload failed (${r.status}): ${String(r.body).slice(0, 300)}`);
    }
    throw new Error('Upload ended unexpectedly');
  }

  async _queryOffset(uri, size, signal) {
    const r = await this._httpPut(uri, { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' }, null, signal);
    if (r.status === 200 || r.status === 201) return { done: true, file: JSON.parse(r.body || '{}') };
    if (r.status === 308) {
      const range = r.headers.range;
      return { offset: range ? Number(/bytes=0-(\d+)/.exec(range)[1]) + 1 : 0 };
    }
    return null;
  }

  async _putChunk(uri, filePath, start, end, size, signal, onBytes) {
    const stream = fs.createReadStream(filePath, { start, end, highWaterMark: 256 * 1024 });
    return this._httpPut(
      uri,
      { 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
      stream,
      signal,
      onBytes
    );
  }

  async _httpPut(uri, headers, stream, signal, onBytes) {
    const token = await this.token();
    return new Promise((resolve, reject) => {
      const req = (uri.startsWith('http:') ? http : https).request(uri, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, ...headers } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        res.on('error', reject);
      });
      const onAbort = () => {
        req.destroy(new AbortError());
        stream?.destroy();
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      req.setTimeout(120000, () => req.destroy(new Error('Upload timed out')));
      req.on('error', (e) => {
        signal?.removeEventListener('abort', onAbort);
        stream?.destroy();
        reject(e);
      });
      req.on('close', () => signal?.removeEventListener('abort', onAbort));
      if (!stream) return req.end();
      let sent = 0;
      stream.on('data', (chunk) => {
        sent += chunk.length;
        if (!req.write(chunk)) stream.pause();
        onBytes?.(sent);
      });
      req.on('drain', () => stream.resume());
      stream.on('end', () => req.end());
      stream.on('error', (e) => req.destroy(e));
    });
  }
}

module.exports = {
  DriveClient,
  parseDriveLink,
  isDriveLink,
  exportInfo,
  apiDownloadUrl,
  publicDownloadUrl,
  resolvePublicFile,
  parseConfirmPage,
  listPublicFolder,
  walkPublicFolder,
  FOLDER_MIME
};
