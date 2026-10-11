'use strict';

/**
 * Google OAuth 2.0 for installed apps (loopback redirect + PKCE).
 * Supports several Google accounts at once; refresh tokens are encrypted with
 * the OS keychain (Electron safeStorage) before being written to disk.
 */

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SCOPES = ['https://www.googleapis.com/auth/drive'];

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const SUCCESS_HTML = `<!doctype html><meta charset="utf-8"><title>DriveRelay</title>
<body style="font-family:system-ui;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:48px">✅</div><h2>Signed in to DriveRelay</h2>
<p>You can close this tab and return to the app.</p></div></body>`;

class GoogleAuth extends EventEmitter {
  /**
   * @param {object} o { store: JsonStore({accounts:[]}), getClient: () => ({clientId, clientSecret}),
   *                     openExternal(url), encrypt(str)->str, decrypt(str)->str }
   */
  constructor(o) {
    super();
    this.o = o;
    this.store = o.store;
    this.cache = new Map(); // accountId -> { accessToken, expiresAt }
    this._refreshing = new Map();
  }

  accounts() {
    return this.store.data.accounts.map((a) => ({
      id: a.id,
      email: a.email,
      name: a.name,
      photo: a.photo,
      needsReauth: !!a.needsReauth
    }));
  }

  hasAccount(id) {
    return this.store.data.accounts.some((a) => a.id === id);
  }

  defaultAccountId() {
    return this.store.data.accounts[0]?.id || null;
  }

  _client() {
    const c = this.o.getClient() || {};
    if (!c.clientId || !c.clientSecret) {
      throw new Error('Google OAuth client is not configured. Open Settings → Google API and add your Client ID and Secret.');
    }
    return c;
  }

  /** Interactive sign-in. Opens the system browser and waits for the redirect. */
  async signIn() {
    const { clientId, clientSecret } = this._client();
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const { code, redirectUri } = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/') {
          res.writeHead(404);
          return res.end();
        }
        const err = u.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h3>Sign-in failed: ${err.replace(/[<>&]/g, '')}</h3>`);
          finish(new Error(`Google sign-in failed: ${err}`));
          return;
        }
        if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) {
          res.writeHead(400);
          return res.end('Invalid state');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SUCCESS_HTML);
        finish(null, { code: u.searchParams.get('code'), redirectUri });
      });
      let redirectUri;
      const timer = setTimeout(() => finish(new Error('Sign-in timed out')), 5 * 60 * 1000);
      const finish = (e, v) => {
        clearTimeout(timer);
        server.close();
        this._abortSignIn = null;
        e ? reject(e) : resolve(v);
      };
      this._abortSignIn = () => finish(new Error('Sign-in canceled'));
      server.listen(0, '127.0.0.1', () => {
        redirectUri = `http://127.0.0.1:${server.address().port}`;
        const url = new URL(AUTH_URL);
        url.search = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPES.join(' '),
          code_challenge: challenge,
          code_challenge_method: 'S256',
          access_type: 'offline',
          prompt: 'consent select_account',
          state
        }).toString();
        this.o.openExternal(url.toString());
      });
      server.on('error', (e) => finish(e));
    });

    const tokens = await this._tokenRequest({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier
    });
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Remove the app from your Google account permissions and try again.');

    const accessToken = tokens.access_token;
    const about = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
      headers: { Authorization: `Bearer ${accessToken}` }
    }).then((r) => r.json());
    const user = about.user || {};
    const id = user.emailAddress || user.permissionId || crypto.randomUUID();
    const account = {
      id,
      email: user.emailAddress || id,
      name: user.displayName || user.emailAddress || 'Google account',
      photo: user.photoLink || null,
      refreshToken: this.o.encrypt(tokens.refresh_token),
      needsReauth: false
    };
    const list = this.store.data.accounts.filter((a) => a.id !== id);
    list.push(account);
    this.store.data.accounts = list;
    this.store.saveNow();
    this.cache.set(id, { accessToken, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 });
    this.emit('changed');
    return this.accounts().find((a) => a.id === id);
  }

  cancelSignIn() {
    if (this._abortSignIn) this._abortSignIn();
  }

  async signOut(id) {
    const acc = this.store.data.accounts.find((a) => a.id === id);
    if (!acc) return;
    try {
      const rt = this.o.decrypt(acc.refreshToken);
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(rt)}`, { method: 'POST' });
    } catch {
      /* ignore */
    }
    this.store.data.accounts = this.store.data.accounts.filter((a) => a.id !== id);
    this.store.saveNow();
    this.cache.delete(id);
    this.emit('changed');
  }

  async _tokenRequest(params) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(json.error_description || json.error || `Token request failed (${res.status})`);
      e.code = json.error;
      throw e;
    }
    return json;
  }

  /** Returns a valid access token for the account, refreshing when needed. */
  async getAccessToken(id, force = false) {
    id = id || this.defaultAccountId();
    if (!id) throw new Error('No Google account connected. Sign in from the Accounts page.');
    const c = this.cache.get(id);
    if (!force && c && c.expiresAt > Date.now()) return c.accessToken;
    if (this._refreshing.has(id)) return this._refreshing.get(id);
    const p = (async () => {
      const acc = this.store.data.accounts.find((a) => a.id === id);
      if (!acc) throw new Error(`Google account ${id} is not connected`);
      const { clientId, clientSecret } = this._client();
      try {
        const t = await this._tokenRequest({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: this.o.decrypt(acc.refreshToken),
          grant_type: 'refresh_token'
        });
        this.cache.set(id, { accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 });
        if (acc.needsReauth) {
          acc.needsReauth = false;
          this.store.save();
          this.emit('changed');
        }
        return t.access_token;
      } catch (e) {
        if (e.code === 'invalid_grant') {
          acc.needsReauth = true;
          this.store.save();
          this.emit('changed');
          throw new Error(`Google account ${acc.email} needs to sign in again`);
        }
        throw e;
      }
    })().finally(() => this._refreshing.delete(id));
    this._refreshing.set(id, p);
    return p;
  }
}

module.exports = { GoogleAuth, SCOPES };
