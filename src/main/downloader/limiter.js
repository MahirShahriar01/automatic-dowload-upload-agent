'use strict';

/**
 * Global token-bucket bandwidth limiter shared by every download worker.
 * rate = bytes per second, 0 = unlimited.
 */
class Limiter {
  constructor(rate = 0) {
    this.setRate(rate);
  }

  setRate(rate) {
    this.rate = Math.max(0, Number(rate) || 0);
    this.tokens = this.rate;
    this.last = Date.now();
  }

  async consume(n, signal) {
    if (!this.rate) return;
    const now = Date.now();
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    this.tokens -= n;
    if (this.tokens < 0) {
      const wait = Math.min(5000, (-this.tokens / this.rate) * 1000);
      await new Promise((resolve) => {
        const t = setTimeout(resolve, wait);
        if (signal) signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
      });
    }
  }
}

module.exports = { Limiter };
