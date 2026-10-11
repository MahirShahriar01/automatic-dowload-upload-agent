'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set([
  'downloads:progress',
  'downloads:task',
  'downloads:removed',
  'transfers:update',
  'transfers:removed',
  'accounts:changed',
  'bridge:status',
  'prefill:download',
  'prefill:relay',
  'nav'
]);

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event ${channel}`);
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  platform: process.platform
});
