'use strict';
/* Renders build/icon.svg to PNG (1024) with headless Chromium, then builds .ico. */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

(async () => {
  const root = path.join(__dirname, '..');
  const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  const png = path.join(root, 'build', 'icon.png');
  await page.locator('svg').screenshot({ path: png, omitBackground: true });
  await browser.close();
  fs.copyFileSync(png, path.join(root, 'src', 'renderer', 'assets', 'icon.png'));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const tmp = sizes.map((s) => {
    const f = path.join(root, 'build', `icon-${s}.png`);
    execFileSync('convert', [png, '-resize', `${s}x${s}`, f]);
    return f;
  });
  execFileSync('convert', [...tmp, path.join(root, 'build', 'icon.ico')]);
  for (const f of tmp) fs.rmSync(f);
  // Extension icons
  for (const s of [16, 32, 48, 128]) {
    execFileSync('convert', [png, '-resize', `${s}x${s}`, path.join(root, 'extension', 'icons', `icon${s}.png`)]);
  }
  console.log('icons written');
})();
