'use strict';

const ext = globalThis.browser || globalThis.chrome;
const $ = (s) => document.querySelector(s);

(async () => {
  const c = await ext.storage.local.get({ port: 6801, enabled: true, skipDomains: '' });
  $('#port').value = c.port;
  $('#enabled').checked = c.enabled;
  $('#skip').value = c.skipDomains;
  $('#save').addEventListener('click', async () => {
    await ext.storage.local.set({
      port: Number($('#port').value) || 6801,
      enabled: $('#enabled').checked,
      skipDomains: $('#skip').value
    });
    $('#saved').textContent = 'Saved ✓';
    setTimeout(() => ($('#saved').textContent = ''), 2000);
  });
  $('#perm').addEventListener('click', async () => {
    const ok = await ext.permissions.request({ origins: ['<all_urls>'] });
    $('#saved').textContent = ok ? 'Permission granted ✓' : 'Permission denied';
  });
})();
