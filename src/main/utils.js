'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;
const RESERVED_WIN = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Make a string safe to use as a file name on Windows, macOS and Linux. */
function sanitizeFilename(name, fallback = 'download') {
  let n = String(name || '').replace(INVALID_CHARS, '_').replace(/[. ]+$/, '').trim();
  if (!n || n === '.' || n === '..') n = fallback;
  if (RESERVED_WIN.test(n)) n = '_' + n;
  // Keep within a sane length while preserving the extension.
  if (Buffer.byteLength(n) > 200) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n;
}

/** Sanitize every segment of a relative path ("a/b/c.txt"). */
function sanitizeRelPath(rel) {
  return String(rel || '')
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => sanitizeFilename(s))
    .join(path.sep);
}

/** Returns a path that does not exist yet: "file.zip" -> "file (1).zip". */
function uniquePath(p, taken = new Set()) {
  if (!fs.existsSync(p) && !fs.existsSync(p + '.part') && !taken.has(p)) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  for (let i = 1; i < 10000; i++) {
    const c = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(c) && !fs.existsSync(c + '.part') && !taken.has(c)) return c;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

/** Parse a Content-Disposition header and return the file name, if any. */
function filenameFromDisposition(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  if (plain) {
    const v = (plain[2] !== undefined ? plain[2] : plain[1]).trim();
    try {
      // Some servers send raw UTF-8 bytes interpreted as latin1.
      const bytes = Buffer.from(v, 'latin1');
      const utf = bytes.toString('utf8');
      return utf.includes('�') ? v : utf;
    } catch {
      return v;
    }
  }
  return null;
}

const MIME_EXT = {
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/pdf': '.pdf',
  'application/x-rar-compressed': '.rar',
  'application/vnd.rar': '.rar',
  'application/x-7z-compressed': '.7z',
  'application/gzip': '.gz',
  'application/x-msdownload': '.exe',
  'application/x-apple-diskimage': '.dmg',
  'application/octet-stream': '',
  'video/mp4': '.mp4',
  'video/x-matroska': '.mkv',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'text/plain': '.txt',
  'text/html': '.html',
  'application/json': '.json'
};

function extFromMime(mime) {
  if (!mime) return '';
  return MIME_EXT[String(mime).split(';')[0].trim().toLowerCase()] || '';
}

function filenameFromUrl(u) {
  try {
    const url = new URL(u);
    const last = url.pathname.split('/').filter(Boolean).pop();
    if (!last) return null;
    return decodeURIComponent(last);
  } catch {
    return null;
  }
}

function formatBytes(n) {
  if (n == null || !isFinite(n) || n < 0) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : 1)} ${u[i]}`;
}

function id(prefix = '') {
  return prefix + crypto.randomBytes(8).toString('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Simple debounce returning a function with a .flush() helper. */
function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
  wrapped.flush = () => {
    if (t) {
      clearTimeout(t);
      t = null;
      fn();
    }
  };
  return wrapped;
}

class AbortError extends Error {
  constructor(msg = 'Aborted') {
    super(msg);
    this.name = 'AbortError';
  }
}

class HttpError extends Error {
  constructor(status, message, body) {
    super(message || `HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

module.exports = {
  sanitizeFilename,
  sanitizeRelPath,
  uniquePath,
  filenameFromDisposition,
  filenameFromUrl,
  extFromMime,
  formatBytes,
  id,
  sleep,
  debounce,
  AbortError,
  HttpError
};
