'use strict';
/* Builds dist-extension/{chromium,firefox} and zips them. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const src = path.join(root, 'extension');
const out = path.join(root, 'dist-extension');
const pkg = require(path.join(root, 'package.json'));
const base = JSON.parse(fs.readFileSync(path.join(src, 'manifest.base.json'), 'utf8'));
base.version = pkg.version;

const targets = {
  chromium: { ...base, background: { service_worker: 'background.js' }, minimum_chrome_version: '110' },
  firefox: {
    ...base,
    background: { scripts: ['background.js'] },
    browser_specific_settings: { gecko: { id: 'driverelay@mahirshahriar', strict_min_version: '115.0' } }
  }
};

fs.rmSync(out, { recursive: true, force: true });
for (const [name, manifest] of Object.entries(targets)) {
  const dir = path.join(out, name);
  fs.mkdirSync(path.join(dir, 'icons'), { recursive: true });
  for (const f of fs.readdirSync(path.join(src, 'src'))) fs.copyFileSync(path.join(src, 'src', f), path.join(dir, f));
  for (const f of fs.readdirSync(path.join(src, 'icons'))) fs.copyFileSync(path.join(src, 'icons', f), path.join(dir, 'icons', f));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const zip = path.join(out, `DriveRelay-extension-${name}-${pkg.version}.${name === 'firefox' ? 'xpi' : 'zip'}`);
  try {
    execFileSync('zip', ['-qr', zip, '.'], { cwd: dir });
  } catch {
    // zip not available (e.g. Windows CI): use PowerShell
    execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${dir}\\*' -DestinationPath '${zip.replace(/\.xpi$/, '.zip')}' -Force`]);
    if (zip.endsWith('.xpi')) fs.renameSync(zip.replace(/\.xpi$/, '.zip'), zip);
  }
}
fs.writeFileSync(
  path.join(out, 'README.txt'),
  `DriveRelay browser extension\n\nChrome / Edge / Brave / Opera:\n  1. open chrome://extensions (edge://extensions)\n  2. enable Developer mode\n  3. Load unpacked -> select the "chromium" folder\n\nFirefox:\n  1. open about:debugging#/runtime/this-firefox\n  2. Load Temporary Add-on -> select firefox/manifest.json\n`
);
console.log('extension built in', out);
