'use strict';

/**
 * Local HTTP bridge used by the browser extension (127.0.0.1 only).
 *
 * Security: web pages cannot talk to it. Every POST must carry the custom
 * "X-DriveRelay" header, which forces a CORS pre-flight; pre-flights are only
 * answered for browser-extension origins, so ordinary websites are refused
 * by the browser before the request is ever sent.
 */

const http = require('http');
const { EventEmitter } = require('events');

const EXT_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension|extension):\/\//i;

class BridgeServer extends EventEmitter {
  /** @param {object} o { port, version, handlers: { download(body), downloads(body), relay(body), show(), status() } } */
  constructor(o) {
    super();
    this.o = o;
    this.server = null;
    this.lastSeen = 0;
    this.port = o.port;
    this.error = null;
  }

  start(port = this.port) {
    this.port = port;
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this._handle(req, res));
      server.on('error', (e) => {
        this.error = e.code === 'EADDRINUSE' ? `Port ${port} is already in use` : e.message;
        this.server = null;
        this.emit('status');
        resolve(false);
      });
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        this.error = null;
        this.emit('status');
        resolve(true);
      });
    });
  }

  async restart(port) {
    await this.stop();
    return this.start(port);
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
      this.server = null;
    });
  }

  status() {
    return {
      running: !!this.server,
      port: this.port,
      error: this.error,
      extensionLastSeen: this.lastSeen
    };
  }

  _cors(req, res) {
    const origin = req.headers.origin;
    if (origin && EXT_ORIGIN.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DriveRelay');
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Vary', 'Origin');
      return true;
    }
    return !origin; // non-browser local clients (curl, scripts) have no Origin
  }

  _send(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  async _handle(req, res) {
    const allowed = this._cors(req, res);
    if (!allowed) return this._send(res, 403, { error: 'Forbidden origin' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/api/ping') {
        if (req.headers.origin) {
          this.lastSeen = Date.now();
          this.emit('status');
        }
        return this._send(res, 200, { ok: true, app: 'DriveRelay', version: this.o.version, ...this.o.handlers.status() });
      }
      if (req.method !== 'POST') return this._send(res, 404, { error: 'Not found' });
      if (req.headers['x-driverelay'] !== '1') return this._send(res, 400, { error: 'Missing X-DriveRelay header' });
      const body = await readJson(req);
      this.lastSeen = Date.now();
      const route = {
        '/api/download': 'download',
        '/api/downloads': 'downloads',
        '/api/relay': 'relay',
        '/api/show': 'show'
      }[url.pathname];
      if (!route) return this._send(res, 404, { error: 'Not found' });
      const result = await this.o.handlers[route](body);
      return this._send(res, 200, { ok: true, ...(result || {}) });
    } catch (e) {
      return this._send(res, 500, { ok: false, error: e.message || String(e) });
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

module.exports = { BridgeServer };
