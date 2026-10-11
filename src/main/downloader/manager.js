'use strict';

const fs = require('fs');
const { EventEmitter } = require('events');
const { DownloadTask } = require('./engine');
const { Limiter } = require('./limiter');
const { id } = require('../utils');

/**
 * Queue of DownloadTasks: limits concurrent downloads, persists state,
 * broadcasts progress, restores unfinished downloads on start-up.
 */
class DownloadManager extends EventEmitter {
  /**
   * @param {object} o { store: JsonStore(array), settings: () => settings,
   *                     getAuthHeaders(task), onAuthError(task), onProbe(task,res) }
   */
  constructor(o) {
    super();
    this.store = o.store;
    this.settings = o.settings;
    this.hooks = o;
    this.limiter = new Limiter((this.settings().speedLimitKBps || 0) * 1024);
    this.tasks = new Map();
    for (const s of this.store.data) {
      if (['connecting', 'downloading'].includes(s.status)) s.status = this.settings().autoResume ? 'queued' : 'paused';
      this._attach(new DownloadTask(s, this._taskOpts()));
    }
    this._timer = setInterval(() => this._tick(), 1000);
    setImmediate(() => this._schedule());
  }

  _taskOpts() {
    return {
      limiter: this.limiter,
      maxRetries: this.settings().maxRetries ?? 6,
      userAgent: this.settings().userAgent || undefined,
      getAuthHeaders: this.hooks.getAuthHeaders,
      onAuthError: this.hooks.onAuthError,
      onProbe: this.hooks.onProbe
    };
  }

  _attach(task) {
    this.tasks.set(task.id, task);
    task.on('status', (t) => {
      this._persist();
      this.emit('task', t.view());
      if (t.status === 'completed') this.emit('completed', t);
      if (t.status === 'error') this.emit('failed', t);
      if (!t.active) setImmediate(() => this._schedule());
    });
    return task;
  }

  _persist() {
    this.store.data = [...this.tasks.values()].map((t) => t.toJSON());
    this.store.save();
  }

  _tick() {
    const views = [];
    for (const t of this.tasks.values()) {
      if (t.active || t.speed) {
        t.tick();
        views.push(t.view());
      }
    }
    if (views.length) {
      this.emit('progress', views);
      this._persist();
    }
  }

  _schedule() {
    const max = Math.max(1, this.settings().maxConcurrent || 3);
    let running = [...this.tasks.values()].filter((t) => t.active).length;
    for (const t of this.tasks.values()) {
      if (running >= max) break;
      if (t.status === 'queued') {
        running++;
        t.start();
      }
    }
  }

  setSpeedLimit(kbps) {
    this.limiter.setRate((kbps || 0) * 1024);
  }

  /**
   * Add a download.
   * @param {object} o { url, dir, filename, connections, headers, auth, meta, transferId, start=true }
   */
  add(o) {
    const s = this.settings();
    const task = new DownloadTask(
      {
        id: id('d_'),
        url: o.url,
        dir: o.dir || s.downloadDir,
        filename: o.filename || null,
        savePath: o.savePath || null,
        connections: o.connections || s.connections || 8,
        headers: o.headers || {},
        auth: o.auth || null,
        meta: o.meta || {},
        transferId: o.transferId || null,
        totalBytes: o.size || -1,
        status: o.start === false ? 'paused' : 'queued'
      },
      this._taskOpts()
    );
    this._attach(task);
    this._persist();
    this.emit('task', task.view());
    this._schedule();
    return task;
  }

  get(taskId) {
    return this.tasks.get(taskId);
  }

  list() {
    return [...this.tasks.values()].map((t) => t.view());
  }

  async pause(taskId) {
    const t = this.tasks.get(taskId);
    if (t) await t.pause();
  }

  resume(taskId) {
    const t = this.tasks.get(taskId);
    if (!t || t.active || t.status === 'completed') return;
    t.opts = this._taskOpts();
    t.error = null;
    t.status = 'queued';
    this.emit('task', t.view());
    this._persist();
    this._schedule();
  }

  /** Restart from zero (e.g. link expired) keeping the same target path. */
  async restart(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    await t.pause();
    if (t.tmpPath) await fs.promises.rm(t.tmpPath, { force: true }).catch(() => {});
    t.segments = [];
    t._probed = false;
    t.totalBytes = -1;
    this.resume(taskId);
  }

  async remove(taskId, deleteFile = false) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    if (t.status !== 'completed') await t.cancel(true);
    else if (deleteFile && t.savePath) await fs.promises.rm(t.savePath, { force: true }).catch(() => {});
    t.removeAllListeners();
    this.tasks.delete(taskId);
    this._persist();
    this.emit('removed', taskId);
    this._schedule();
  }

  async pauseAll() {
    await Promise.all([...this.tasks.values()].filter((t) => t.active || t.status === 'queued').map((t) => t.pause()));
  }

  resumeAll() {
    for (const t of this.tasks.values()) if (['paused', 'error'].includes(t.status)) this.resume(t.id);
  }

  clearCompleted() {
    for (const t of [...this.tasks.values()]) {
      if (t.status === 'completed' || t.status === 'canceled') {
        t.removeAllListeners();
        this.tasks.delete(t.id);
        this.emit('removed', t.id);
      }
    }
    this._persist();
  }

  /** Resolves when the task reaches a terminal state. */
  waitFor(taskId) {
    return new Promise((resolve, reject) => {
      const t = this.tasks.get(taskId);
      if (!t) return reject(new Error('Download removed'));
      const check = () => {
        if (t.status === 'completed') return done(resolve, t);
        if (t.status === 'error') return done(reject, new Error(t.error || 'Download failed'));
        if (t.status === 'canceled') return done(reject, new Error('Download canceled'));
      };
      const onRemoved = (rid) => rid === taskId && done(reject, new Error('Download removed'));
      const done = (fn, v) => {
        t.off('status', check);
        this.off('removed', onRemoved);
        fn(v);
      };
      t.on('status', check);
      this.on('removed', onRemoved);
      check();
    });
  }

  async shutdown() {
    clearInterval(this._timer);
    const active = [...this.tasks.values()].filter((t) => t.active);
    for (const t of active) {
      t.status = 'paused';
      if (t._controller) t._controller.abort();
    }
    await Promise.all(active.map((t) => t._running && t._running.catch(() => {})));
    // Mark them queued so they auto-resume next launch.
    for (const t of active) t.status = 'queued';
    this._persist();
    this.store.flush();
  }
}

module.exports = { DownloadManager };
