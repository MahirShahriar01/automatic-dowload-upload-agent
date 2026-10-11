'use strict';

/**
 * Turn "share page" links from popular hosts into direct-download links.
 * Google Drive links are handled separately (see google/drive.js) because
 * they may need an account.
 */
async function resolveDirectUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    throw new Error('That does not look like a valid link.');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links can be downloaded.');
  const host = u.hostname.toLowerCase();

  // Dropbox: ?dl=0 -> ?dl=1
  if (/(^|\.)dropbox\.com$/.test(host)) {
    u.searchParams.delete('dl');
    u.searchParams.set('dl', '1');
    return { url: u.toString() };
  }
  // GitHub "blob" page -> raw file
  if (host === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname);
    if (m) return { url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` };
  }
  // OneDrive / SharePoint share links: ask for the raw download.
  if (/(^|\.)(1drv\.ms|onedrive\.live\.com)$/.test(host) || /sharepoint\.com$/.test(host)) {
    if (!u.searchParams.has('download')) u.searchParams.set('download', '1');
    return { url: u.toString() };
  }
  return { url: u.toString() };
}

module.exports = { resolveDirectUrl };
