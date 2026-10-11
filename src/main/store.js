'use strict';

const fs = require('fs');
const path = require('path');
const { debounce } = require('./utils');

/** Tiny JSON file store with atomic, debounced writes. */
class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = this._load();
    this._save = debounce(() => this.saveNow(), 400);
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(this.defaults)) return Array.isArray(parsed) ? parsed : [];
      return { ...structuredClone(this.defaults), ...parsed };
    } catch {
      return structuredClone(this.defaults);
    }
  }

  save() {
    this._save();
  }

  saveNow() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('store save failed', this.file, e);
    }
  }

  flush() {
    this._save.flush();
  }
}

module.exports = { JsonStore };
