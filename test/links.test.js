'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseDriveLink, parseConfirmPage, apiDownloadUrl } = require('../src/main/google/drive');
const { resolveDirectUrl } = require('../src/main/resolvers');
const { filenameFromDisposition, sanitizeFilename } = require('../src/main/utils');

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123';

test('parses Google Drive link formats', () => {
  const cases = [
    [`https://drive.google.com/file/d/${ID}/view?usp=sharing`, 'file'],
    [`https://drive.google.com/file/u/1/d/${ID}/view`, 'file'],
    [`https://drive.google.com/drive/folders/${ID}?usp=drive_link`, 'folder'],
    [`https://drive.google.com/drive/u/0/folders/${ID}`, 'folder'],
    [`https://drive.google.com/drive/mobile/folders/${ID}?resourcekey=0-abc`, 'folder'],
    [`https://drive.google.com/uc?id=${ID}&export=download`, 'file'],
    [`https://drive.usercontent.google.com/download?id=${ID}&export=download`, 'file'],
    [`https://drive.google.com/open?id=${ID}`, 'unknown'],
    [`https://docs.google.com/document/d/${ID}/edit`, 'file'],
    [`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`, 'file'],
    [`https://drive.google.com/embeddedfolderview?id=${ID}`, 'folder'],
    [ID, 'unknown']
  ];
  for (const [u, kind] of cases) {
    const r = parseDriveLink(u);
    assert.ok(r, u);
    assert.strictEqual(r.kind, kind, u);
    assert.strictEqual(r.id, ID, u);
  }
  assert.strictEqual(parseDriveLink(`https://drive.google.com/drive/mobile/folders/${ID}?resourcekey=0-abc`).resourceKey, '0-abc');
  assert.strictEqual(parseDriveLink('https://example.com/file.zip'), null);
  assert.strictEqual(parseDriveLink('not a link'), null);
});

test('parses the large-file virus-scan confirmation page', () => {
  const html = `<html><body><span class="uc-name-size"><a href="/open?id=${ID}">Big Movie &amp; Co.mkv</a> (2.1G)</span>
  <form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
  <input type="submit" value="Download anyway"/>
  <input type="hidden" name="id" value="${ID}"><input type="hidden" name="export" value="download">
  <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="abc-123"></form></body></html>`;
  const r = parseConfirmPage(html);
  const u = new URL(r.url);
  assert.strictEqual(u.hostname, 'drive.usercontent.google.com');
  assert.strictEqual(u.searchParams.get('id'), ID);
  assert.strictEqual(u.searchParams.get('uuid'), 'abc-123');
  assert.strictEqual(u.searchParams.get('confirm'), 't');
  assert.strictEqual(r.name, 'Big Movie & Co.mkv');
  assert.strictEqual(parseConfirmPage('<html>nothing</html>'), null);
});

test('Google Docs are exported to Office formats', () => {
  assert.match(apiDownloadUrl({ id: 'x', mimeType: 'application/vnd.google-apps.document' }), /export\?mimeType=.*wordprocessingml/);
  assert.match(apiDownloadUrl({ id: 'x', mimeType: 'application/zip' }), /alt=media/);
});

test('converts share pages of common hosts to direct links', async () => {
  assert.strictEqual((await resolveDirectUrl('https://www.dropbox.com/s/abc/file.zip?dl=0')).url, 'https://www.dropbox.com/s/abc/file.zip?dl=1');
  assert.strictEqual(
    (await resolveDirectUrl('https://github.com/user/repo/blob/main/dist/app.zip')).url,
    'https://raw.githubusercontent.com/user/repo/main/dist/app.zip'
  );
  await assert.rejects(resolveDirectUrl('ftp://x/y'), /http/);
});

test('filename helpers', () => {
  assert.strictEqual(filenameFromDisposition('attachment; filename="a b.zip"'), 'a b.zip');
  assert.strictEqual(filenameFromDisposition("attachment; filename*=UTF-8''%E0%A6%AC%E0%A6%BE%E0%A6%82%E0%A6%B2%E0%A6%BE.pdf"), 'বাংলা.pdf');
  assert.strictEqual(sanitizeFilename('a<b>:c?.txt'), 'a_b__c_.txt');
  assert.strictEqual(sanitizeFilename('CON'), '_CON');
  assert.strictEqual(sanitizeFilename('..'), 'download');
});
