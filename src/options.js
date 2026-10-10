'use strict';
const DEFAULTS = { excluded: [], hintChars: 'asdfghjklqwertyuiopzxcvbnm', newTabActive: false };
const $ = id => document.getElementById(id);

browser.storage.local.get(DEFAULTS).then(o => {
  $('excluded').value = o.excluded.join('\n');
  $('hintChars').value = o.hintChars;
  $('newTabActive').checked = !!o.newTabActive;
});

$('save').addEventListener('click', async () => {
  const excluded = $('excluded').value.split('\n').map(s => s.trim()).filter(Boolean);
  const hintChars = $('hintChars').value.toLowerCase().replace(/[^a-z0-9]/g, '');
  await browser.storage.local.set({
    excluded,
    hintChars: hintChars.length >= 4 ? hintChars : DEFAULTS.hintChars,
    newTabActive: $('newTabActive').checked,
  });
  $('status').textContent = 'Saved';
  setTimeout(() => { $('status').textContent = ''; }, 1500);
});
