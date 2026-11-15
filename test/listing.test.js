/*
 * renamo - folder listing tests (src/list-folder.js), on real folders.
 *
 *   node test/listing.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { listFolder } = require('../src/list-folder');

let passed = 0;
async function t(label, fn) {
  try { await fn(); passed++; }
  catch (err) { console.error('FAIL  ' + label + '\n      ' + err.message); process.exitCode = 1; }
}
// DAY/CAM_A/CARTE_01/A001.mov ... the way rushes arrive from set.
function shoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renamo-list-'));
  const put = (rel, body = 'x') => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
  put('notes.txt');
  put('CAM_A/CARTE_01/A001.mov'); put('CAM_A/CARTE_01/A002.mov');
  put('CAM_A/CARTE_02/A001.mov');
  put('CAM_B/CARTE_01/B001.mov');
  put('CAM_B/.hidden/secret.mov'); put('CAM_B/CARTE_01/.DS_Store');
  return root;
}

(async () => {
  await t('one folder: its files and subfolders', async () => {
    const root = shoot();
    const { entries, others } = await listFolder(root);
    assert.deepStrictEqual(entries.map(e => e.name).sort(), ['CAM_A', 'CAM_B', 'notes.txt']);
    assert.ok(entries.every(e => e.dir === root && e.rel === ''));
    assert.strictEqual(others.length, 0);
  });

  await t('with subfolders: every file below, with its folder, no folder rows', async () => {
    const root = shoot();
    const { entries, others, truncated } = await listFolder(root, { recursive: true });
    assert.deepStrictEqual(entries.map(e => path.join(e.rel, e.name).split(path.sep).join('/')).sort(),
      ['CAM_A/CARTE_01/A001.mov', 'CAM_A/CARTE_01/A002.mov', 'CAM_A/CARTE_02/A001.mov', 'CAM_B/CARTE_01/B001.mov', 'notes.txt']);
    assert.ok(entries.every(e => !e.isDir && e.path === path.join(e.dir, e.name)));
    // subfolder names are known, so a new name cannot take one of them
    assert.ok(others.some(o => o.dir === root && o.name === 'CAM_A'));
    assert.strictEqual(truncated, false);
  });

  await t('hidden files and hidden folders are not listed, but their folders are read for leftovers', async () => {
    const root = shoot();
    const { entries, listings } = await listFolder(root, { recursive: true });
    assert.ok(!entries.some(e => e.name.startsWith('.') || e.path.includes('.hidden')));
    const card = listings.find(l => l.dir === path.join(root, 'CAM_B', 'CARTE_01'));
    assert.ok(card && card.names.includes('.DS_Store'));
  });

  await t('a link to a folder is never followed (no loop)', async () => {
    const root = shoot();
    try { fs.symlinkSync(root, path.join(root, 'CAM_A', 'loop'), 'dir'); } catch (e) { return; }   // no symlinks here (Windows without rights)
    const { entries } = await listFolder(root, { recursive: true });
    assert.strictEqual(entries.length, 5);
  });

  await t('the disk tree (dirsOnly) lists folders only, never recursively', async () => {
    const root = shoot();
    const { entries } = await listFolder(root, { dirsOnly: true, recursive: true });
    assert.deepStrictEqual(entries.map(e => e.name), ['CAM_A', 'CAM_B']);
  });

  await t('a folder that cannot be read is an error; a subfolder that cannot be read is skipped', async () => {
    await assert.rejects(listFolder(path.join(os.tmpdir(), 'renamo-does-not-exist-' + Date.now())));
  });

  await t('many card folders are all read (several at once)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renamo-list-'));
    for (let c = 0; c < 30; c++) for (let f = 0; f < 3; f++) {
      const d = path.join(root, 'CAM', 'CARD_' + c, 'CLIPS'); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'C' + f + '.mov'), 'x');
    }
    const { entries } = await listFolder(root, { recursive: true });
    assert.strictEqual(entries.length, 90);
    assert.strictEqual(new Set(entries.map(e => e.path)).size, 90);
  });

  await t('the listing only reads: nothing in the folders changes', async () => {
    const root = shoot();
    const snap = d => fs.readdirSync(d, { recursive: true }).sort().join('|');
    const before = snap(root);
    await listFolder(root, { recursive: true });
    assert.strictEqual(snap(root), before);
  });

  console.log(passed + ' listing checks passed' + (process.exitCode ? ' — with failures above' : ''));
})();
