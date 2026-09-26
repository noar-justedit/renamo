/*
 * renamo - safety tests for the rename engine
 *
 * The one promise: renamo never loses a file, whatever happens.
 * Every scenario runs on real files in a temporary folder and checks the
 * invariant at the end: the same files, with the same contents, are all still
 * there (hidden ones included). Failures of the file system are simulated by
 * wrapping `fs`: a rename that errors, a rename that "succeeds" but whose file
 * vanishes (what a misbehaving network share can do), a crash mid-batch.
 *
 *   node test/safety.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { createEngine } = require('../src/rename-engine');

let passed = 0;
function t(label, fn) {
  try { fn(); passed++; }
  catch (err) { console.error('FAIL  ' + label + '\n      ' + (err && err.stack || err)); process.exitCode = 1; }
}

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'renamo-safety-')); }
function write(dir, name, content) { fs.writeFileSync(path.join(dir, name), content); return path.join(dir, name); }
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
// Contents of every file in the folder, hidden ones included, as a sorted list.
function contents(dir) { return fs.readdirSync(dir).map(n => sha(fs.readFileSync(path.join(dir, n)))).sort(); }
function names(dir) { return fs.readdirSync(dir).sort(); }
function mkfiles(dir, n, prefix = 'A001C') {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(write(dir, prefix + String(i).padStart(3, '0') + '.mov', 'clip ' + i + ' ' + crypto.randomBytes(64).toString('hex')));
  return out;
}
const withSuffix = (p, suf) => { const e = path.extname(p); return p.slice(0, -e.length) + suf + e; };

// fs wrapper: lets a test decide what each renameSync does.
function faultyFs(hook) {
  const w = Object.create(fs);
  let n = 0;
  w.renameSync = (a, b) => {
    n++;
    const r = hook(n, a, b);
    if (r === 'throw') { const e = new Error('simulated I/O error'); e.code = 'EIO'; throw e; }
    if (r === 'vanish') {                       // the share accepts the rename, then the file is gone from view
      fs.renameSync(a, b);
      const q = path.join(path.dirname(path.dirname(b)), 'quarantine-' + path.basename(path.dirname(b)));
      fs.mkdirSync(q, { recursive: true });
      fs.renameSync(b, path.join(q, path.basename(b)));
      return;
    }
    return fs.renameSync(a, b);
  };
  w.count = () => n;
  return w;
}

// ── the plain case ─────────────────────────────────────────────────────────
t('adding a suffix renames every file directly, with no temporary name at all', () => {
  const d = tmpdir(); const files = mkfiles(d, 50); const before = contents(d);
  const seen = [];
  const e = createEngine({ fs: faultyFs((n, a, b) => { seen.push(path.basename(b)); }) });
  const res = e.renameBatch(files.map(f => ({ from: f, to: withSuffix(f, '_V2') })));
  assert.strictEqual(res.done.length, 50); assert.strictEqual(res.failed.length, 0);
  assert.deepStrictEqual(contents(d), before, 'contents changed');
  assert.ok(seen.every(n => /_V2\.mov$/.test(n)), 'a temporary name was used: ' + seen.find(n => !/_V2\.mov$/.test(n)));
  assert.strictEqual(seen.length, 50, 'more than one rename per file');
  assert.ok(names(d).every(n => /_V2\.mov$/.test(n)));
});

t('no file name starting with a dot is ever created', () => {
  const d = tmpdir(); const [a, b] = mkfiles(d, 2);
  const seen = [];
  const e = createEngine({ fs: faultyFs((n, x, y) => { seen.push(path.basename(y)); }) });
  e.renameBatch([{ from: a, to: b }, { from: b, to: a }]);        // a swap needs temporary names
  assert.ok(seen.length > 0);
  assert.ok(seen.every(n => !n.startsWith('.')), 'hidden name used: ' + seen.join(', '));
});

// ── swaps and chains ───────────────────────────────────────────────────────
t('a swap of two names exchanges them, visible temporary names only, none left', () => {
  const d = tmpdir(); const [a, b] = mkfiles(d, 2);
  const ca = fs.readFileSync(a), cb = fs.readFileSync(b);
  const res = createEngine().renameBatch([{ from: a, to: b }, { from: b, to: a }]);
  assert.strictEqual(res.failed.length, 0);
  assert.deepStrictEqual(fs.readFileSync(b), ca); assert.deepStrictEqual(fs.readFileSync(a), cb);
  assert.deepStrictEqual(names(d), [path.basename(a), path.basename(b)].sort());
});

t('a chain A→B, B→C lands every file where expected', () => {
  const d = tmpdir(); const [a, b] = mkfiles(d, 2); const c = path.join(d, 'C.mov');
  const ca = fs.readFileSync(a), cb = fs.readFileSync(b);
  const res = createEngine().renameBatch([{ from: a, to: b }, { from: b, to: c }]);
  assert.strictEqual(res.failed.length, 0);
  assert.deepStrictEqual(fs.readFileSync(b), ca); assert.deepStrictEqual(fs.readFileSync(c), cb);
});

// ── never overwrite ────────────────────────────────────────────────────────
t('an existing file is never overwritten, and the source stays untouched', () => {
  const d = tmpdir(); const [a] = mkfiles(d, 1); const x = write(d, 'TAKEN.mov', 'precious');
  const before = contents(d);
  const res = createEngine().renameBatch([{ from: a, to: x }]);
  assert.strictEqual(res.done.length, 0); assert.strictEqual(res.failed[0].now, a);
  assert.deepStrictEqual(contents(d), before);
  assert.strictEqual(fs.readFileSync(x, 'utf8'), 'precious');
});

t('a target that differs only by case from an existing file counts as taken', () => {
  const d = tmpdir(); const [a] = mkfiles(d, 1); write(d, 'taken.MOV', 'precious');
  const before = contents(d);
  const res = createEngine().renameBatch([{ from: a, to: path.join(d, 'TAKEN.mov') }]);
  assert.strictEqual(res.done.length, 0);
  assert.deepStrictEqual(contents(d), before);
});

t('a hidden file is protected too (renamo does not list it, the engine sees it)', () => {
  const d = tmpdir(); const [a] = mkfiles(d, 1); write(d, '.hidden.mov', 'precious');
  const before = contents(d);
  const res = createEngine().renameBatch([{ from: a, to: path.join(d, '.hidden.mov') }]);
  assert.strictEqual(res.done.length, 0); assert.deepStrictEqual(contents(d), before);
});

t('two files aimed at the same name: only one moves, nothing is lost', () => {
  const d = tmpdir(); const [a, b] = mkfiles(d, 2); const before = contents(d);
  const res = createEngine().renameBatch([{ from: a, to: path.join(d, 'SAME.mov') }, { from: b, to: path.join(d, 'SAME.mov') }]);
  assert.strictEqual(res.done.length, 1); assert.strictEqual(res.failed.length, 1);
  assert.deepStrictEqual(contents(d), before);
});

// ── simulated failures ─────────────────────────────────────────────────────
t('a rename that errors leaves that file under its original name, the rest goes on', () => {
  const d = tmpdir(); const files = mkfiles(d, 10); const before = contents(d);
  const e = createEngine({ fs: faultyFs(n => (n === 4 ? 'throw' : null)) });
  const res = e.renameBatch(files.map(f => ({ from: f, to: withSuffix(f, '_V2') })));
  assert.strictEqual(res.done.length, 9); assert.strictEqual(res.failed.length, 1);
  assert.strictEqual(res.failed[0].now, res.failed[0].from, 'the failed file is not where the report says');
  assert.ok(fs.existsSync(res.failed[0].from));
  assert.deepStrictEqual(contents(d), before);
});

t('a file that vanishes after its rename stops the batch at once; nothing else is touched', () => {
  const d = tmpdir(); const files = mkfiles(d, 20);
  const e = createEngine({ fs: faultyFs(n => (n === 1 ? 'vanish' : null)) });
  const res = e.renameBatch(files.map(f => ({ from: f, to: withSuffix(f, '_V2') })));
  assert.strictEqual(res.halted, true, 'the batch did not stop');
  assert.strictEqual(res.done.length, 0);
  // 19 files never touched, under their original names
  const left = names(d);
  assert.strictEqual(left.length, 19);
  assert.ok(left.every(n => !/_V2/.test(n)), 'renamo went on renaming after the anomaly');
  assert.strictEqual(res.failed.find(f => f.error.includes('could not be found')).now, null, 'the lost file must be reported as not found');
  assert.strictEqual(res.failed.filter(f => f.error === 'batch stopped before this file').length, 19);
});

t('in a swap, a failed second step puts the first file back or keeps it visible with its name', () => {
  const d = tmpdir(); const [a, b] = mkfiles(d, 2); const before = contents(d);
  // calls: 1 = a→tmp and b→tmp (blockers), then finals; fail the first final rename
  const e = createEngine({ fs: faultyFs(n => (n === 3 ? 'throw' : null)) });
  const res = e.renameBatch([{ from: a, to: b }, { from: b, to: a }]);
  assert.deepStrictEqual(contents(d), before, 'a file was lost');
  assert.ok(names(d).every(n => !n.startsWith('.')), 'a file was left hidden');
  for (const f of res.failed) assert.ok(f.now && fs.existsSync(f.now), 'report points to a missing file: ' + JSON.stringify(f));
});

t('a file waiting under a temporary name goes back to its own name when the next step fails', () => {
  const d = tmpdir(); const [a, b] = mkfiles(d, 2); const c = path.join(d, 'C.mov');
  const before = names(d);
  // B is set aside (call 1), then B -> C fails (call 2): B must come back as B
  const e = createEngine({ fs: faultyFs(n => (n === 2 ? 'throw' : null)) });
  const res = e.renameBatch([{ from: b, to: c }, { from: a, to: b }]);
  assert.deepStrictEqual(names(d), before, 'files are not back under their names: ' + names(d).join(', '));
  assert.ok(res.failed.every(f => f.now === f.from), 'report does not say the files are back');
});

t('a temporary file left by a failure is found and brought back to its original name', () => {
  const d = tmpdir(); const [a] = mkfiles(d, 1);
  fs.renameSync(a, a + '.renamo-tmp');                 // what an interrupted swap would leave
  const e = createEngine();
  const lo = e.findLeftovers(d);
  assert.strictEqual(lo.length, 1); assert.strictEqual(lo[0].original, path.basename(a));
  const res = e.recoverLeftovers(d);
  assert.strictEqual(res.restored.length, 1); assert.ok(fs.existsSync(a));
});

t('hidden leftovers of renamo 1.6.2 are found and brought back, with their extension', () => {
  const d = tmpdir();
  const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), crypto.randomBytes(200)]);
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WAVE'), crypto.randomBytes(200)]);
  write(d, '.renamo_tmp_4242_0_1758500000000', mov);
  write(d, '.renamo_tmp_4242_1_1758500000001', wav);
  write(d, 'untouched.txt', 'keep me');
  const before = contents(d);
  const e = createEngine();
  assert.strictEqual(e.findLeftovers(d).length, 2);
  const res = e.recoverLeftovers(d);
  assert.deepStrictEqual(res.restored.map(r => path.basename(r.to)), ['RECOVERED_001.mov', 'RECOVERED_002.wav']);
  assert.deepStrictEqual(contents(d), before, 'recovery changed or lost a file');
  assert.ok(names(d).every(n => !n.startsWith('.')));
});

t('recovery never overwrites: a name taken since comes back as <name>_RECOVERED', () => {
  const d = tmpdir(); const [a] = mkfiles(d, 1);
  fs.renameSync(a, a + '.renamo-tmp'); write(d, path.basename(a), 'someone else took the name');
  const before = contents(d);
  const res = createEngine().recoverLeftovers(d);
  assert.strictEqual(res.failed.length, 0); assert.strictEqual(res.restored.length, 1);
  assert.strictEqual(path.basename(res.restored[0].to), path.basename(a, '.mov') + '_RECOVERED.mov');
  assert.deepStrictEqual(contents(d), before);
  assert.strictEqual(fs.readFileSync(a, 'utf8'), 'someone else took the name');
});

t('a suffix repeated by a later batch still goes back to the original name', () => {
  const d = tmpdir(); const [a] = mkfiles(d, 1);
  fs.renameSync(a, a + '.renamo-tmp.renamo-tmp-2');
  const e = createEngine();
  assert.strictEqual(e.findLeftovers(d)[0].original, path.basename(a));
  e.recoverLeftovers(d);
  assert.deepStrictEqual(names(d), [path.basename(a)]);
});

t('a file named just ".renamo-tmp" is not taken for a leftover', () => {
  const d = tmpdir(); write(d, '.renamo-tmp', 'not ours');
  assert.strictEqual(createEngine().findLeftovers(d).length, 0);
});

// ── case and accents (1.6.4) ───────────────────────────────────────────────
// A volume that tells case and accents apart (Linux, many NAS shares,
// case-sensitive APFS), simulated in memory so these checks run the same on
// the Mac that builds renamo, whose own disk does not tell them apart.
function strictMemFs(files) {
  const store = new Map();                        // full path -> { data, ino }
  let ino = 100;
  for (const [p, data] of Object.entries(files)) store.set(p, { data, ino: ino++ });
  const err = (code, p) => { const e = new Error(code + ': ' + p); e.code = code; return e; };
  const stat = f => ({ ino: f.ino, dev: 1, size: f.data.length, mtimeMs: 1, birthtimeMs: 1, mode: 0o100644, isDirectory: () => false });
  return {
    store,
    lstatSync: p => { const f = store.get(p); if (!f) throw err('ENOENT', p); return stat(f); },
    readdirSync: d => [...store.keys()].filter(p => path.dirname(p) === d).map(p => path.basename(p)),
    renameSync: (a, b) => { const f = store.get(a); if (!f) throw err('ENOENT', a); store.delete(a); store.set(b, f); },  // POSIX: replaces b
    mkdirSync: () => {}, writeFileSync: () => {}, readFileSync: () => { throw err('ENOENT', 'journal'); },
  };
}
const D = '/vol/rushes';
const contentsOf = m => [...m.store.values()].map(f => f.data).sort();

t('on a volume that tells case apart, a.txt -> A.txt never overwrites the existing A.txt', () => {
  const m = strictMemFs({ [D + '/a.txt']: 'draft', [D + '/A.txt']: 'MASTER' });
  const res = createEngine({ fs: m }).renameBatch([{ from: D + '/a.txt', to: D + '/A.txt' }]);
  assert.strictEqual(res.done.length, 0); assert.strictEqual(res.failed.length, 1);
  assert.deepStrictEqual(contentsOf(m), ['MASTER', 'draft'], 'a file was overwritten');
  assert.strictEqual(m.store.get(D + '/A.txt').data, 'MASTER');
});

t('a case swap between two distinct files loses nothing', () => {
  const m = strictMemFs({ [D + '/a.txt']: 'lower', [D + '/A.txt']: 'UPPER' });
  createEngine({ fs: m }).renameBatch([{ from: D + '/a.txt', to: D + '/A.txt' }, { from: D + '/A.txt', to: D + '/a.txt' }]);
  assert.deepStrictEqual(contentsOf(m), ['UPPER', 'lower'], 'a file was lost');
});

t('two accent forms of one name (NFD / NFC) are two files: never overwritten', () => {
  const m = strictMemFs({ [D + '/Café.mov']: 'nfd', [D + '/Café.mov']: 'nfc' });
  const res = createEngine({ fs: m }).renameBatch([{ from: D + '/Café.mov', to: D + '/Café.mov' }]);
  assert.strictEqual(res.done.length, 0);
  assert.deepStrictEqual(contentsOf(m), ['nfc', 'nfd']);
});

t('on that volume, a plain case-only rename still goes through', () => {
  const m = strictMemFs({ [D + '/clip.mov']: 'x' });
  const res = createEngine({ fs: m }).renameBatch([{ from: D + '/clip.mov', to: D + '/CLIP.mov' }]);
  assert.strictEqual(res.failed.length, 0); assert.deepStrictEqual([...m.store.keys()], [D + '/CLIP.mov']);
});

// The same check on the real disk, when the disk running the tests tells case apart.
{
  const probe = tmpdir(); write(probe, 'case.probe', 'x');
  if (!fs.existsSync(path.join(probe, 'CASE.PROBE'))) {
    t('real disk that tells case apart: a.txt -> A.txt never overwrites A.txt', () => {
      const d = tmpdir(); const a = write(d, 'a.txt', 'draft'); write(d, 'A.txt', 'MASTER');
      const before = contents(d);
      const res = createEngine().renameBatch([{ from: a, to: path.join(d, 'A.txt') }]);
      assert.strictEqual(res.done.length, 0);
      assert.deepStrictEqual(contents(d), before);
    });
  }
}

t('a plain case-only rename still works when no other file has that name', () => {
  const d = tmpdir(); const a = write(d, 'clip.mov', 'x');
  const res = createEngine().renameBatch([{ from: a, to: path.join(d, 'CLIP.mov') }]);
  assert.strictEqual(res.failed.length, 0); assert.deepStrictEqual(names(d), ['CLIP.mov']);
});

// A case-insensitive volume (macOS, Windows, most NAS seen from them), simulated:
// every path is resolved to the entry whose name matches loosely.
function caseInsensitiveFs() {
  const w = Object.create(fs);
  const loose = s => s.normalize('NFC').toLowerCase();
  const real = p => {
    const dir = path.dirname(p), b = path.basename(p);
    const hit = fs.readdirSync(dir).find(n => loose(n) === loose(b));
    return hit ? path.join(dir, hit) : p;
  };
  w.lstatSync = p => fs.lstatSync(real(p));
  w.renameSync = (a, b) => {
    const ra = real(a), rb = real(b);
    if (rb !== b && rb !== ra) { fs.renameSync(ra, rb); return; }   // what the OS does: replaces
    fs.renameSync(ra, b);
  };
  return w;
}
t('on a case-insensitive volume, a case-only rename of a file is accepted (same inode)', () => {
  const d = tmpdir(); const a = write(d, 'clip.mov', 'x');
  const res = createEngine({ fs: caseInsensitiveFs() }).renameBatch([{ from: a, to: path.join(d, 'Clip.MOV') }]);
  assert.strictEqual(res.failed.length, 0, JSON.stringify(res.failed));
  assert.deepStrictEqual(names(d), ['Clip.MOV']);
});

// ── requests that must be refused (1.6.4) ──────────────────────────────────
t('a new name starting with a dot is refused: the file would be hidden', () => {
  const d = tmpdir(); const [a] = mkfiles(d, 1); const before = names(d);
  const res = createEngine().renameBatch([{ from: a, to: path.join(d, '.mov') }]);
  assert.strictEqual(res.done.length, 0); assert.ok(/hidden/.test(res.failed[0].error));
  assert.deepStrictEqual(names(d), before);
});

t('a file is never moved out of its folder, whatever the request says', () => {
  const d = tmpdir(); const other = tmpdir(); const [a] = mkfiles(d, 1);
  const res = createEngine().renameBatch([
    { from: a, to: path.join(other, 'moved.mov') },
    { from: a, to: d + '/sub/../../y.mov' },
    { from: 'relative.mov', to: 'x.mov' },
    { from: 42, to: null }, null,
  ]);
  assert.strictEqual(res.done.length, 0); assert.strictEqual(res.failed.length, 5);
  assert.deepStrictEqual(fs.readdirSync(other), []);
  assert.ok(fs.existsSync(a));
});

t('Windows rules are enforced on Windows: illegal characters, trailing dot, reserved names', () => {
  const e = createEngine({ platform: 'win32' });
  const d = '/tmp/x';
  for (const bad of ['a:b.mov', 'what?.mov', 'end.', 'end ', 'CON', 'nul.txt', 'com1.mov']) {
    assert.ok(e.checkPair({ from: d + '/a.mov', to: d + '/' + bad }), bad + ' was accepted');
  }
  assert.strictEqual(e.checkPair({ from: d + '/a.mov', to: d + '/console.mov' }), null);
});

// ── verification (1.6.4) ───────────────────────────────────────────────────
t('a renamed file whose size reads back different is reported under its new name, and can be undone', () => {
  const d = tmpdir(); const files = mkfiles(d, 3); const before = contents(d);
  const w = Object.create(fs);
  w.lstatSync = p => { const s = fs.lstatSync(p); if (p.endsWith('A001C001_V2.mov')) return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: s.size + 1 }); return s; };
  const res = createEngine({ fs: w }).renameBatch(files.map(f => ({ from: f, to: withSuffix(f, '_V2') })));
  assert.strictEqual(res.halted, true);
  const f = res.failed.find(x => /size/.test(x.error));
  assert.ok(f, 'no size failure reported');
  assert.strictEqual(f.now, withSuffix(files[0], '_V2'), 'the file is not reported where it is');
  assert.ok(res.undo.some(u => u.from === f.now), 'the rename that happened cannot be undone');
  assert.deepStrictEqual(contents(d), before);
  assert.strictEqual(names(d).filter(n => /_V2/.test(n)).length, 1, 'renamo went on after the anomaly');
});

t('an I/O error while checking a rename stops the batch like a missing file', () => {
  const d = tmpdir(); const files = mkfiles(d, 5); const before = contents(d);
  const w = Object.create(fs); let armed = false;
  w.renameSync = (a, b) => { fs.renameSync(a, b); armed = true; };
  w.lstatSync = p => { if (armed && /_V2/.test(p)) { const e = new Error('EIO'); e.code = 'EIO'; throw e; } return fs.lstatSync(p); };
  const res = createEngine({ fs: w }).renameBatch(files.map(f => ({ from: f, to: withSuffix(f, '_V2') })));
  assert.strictEqual(res.halted, true);
  assert.strictEqual(names(d).filter(n => /_V2/.test(n)).length, 1);
  assert.deepStrictEqual(contents(d), before);
});

t('an unreadable file is reported, the batch is not thrown away', () => {
  const d = tmpdir(); const files = mkfiles(d, 3);
  const w = Object.create(fs);
  w.lstatSync = p => { if (p === files[1]) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } return fs.lstatSync(p); };
  const res = createEngine({ fs: w }).renameBatch(files.map(f => ({ from: f, to: withSuffix(f, '_V2') })));
  assert.strictEqual(res.done.length, 2); assert.strictEqual(res.failed.length, 1);
  assert.ok(/cannot be read/.test(res.failed[0].error));
});

// ── cost (1.6.4) ───────────────────────────────────────────────────────────
t('a big batch writes the journal a handful of times, not once per file', () => {
  const d = tmpdir(); const j = path.join(tmpdir(), 'journal.json'); const files = mkfiles(d, 1000);
  const w = Object.create(fs); let writes = 0, stats = 0;
  w.writeFileSync = (...a) => { writes++; return fs.writeFileSync(...a); };
  w.lstatSync = p => { stats++; return fs.lstatSync(p); };
  const res = createEngine({ fs: w, journalPath: j }).renameBatch(files.map(f => ({ from: f, to: withSuffix(f, '_V2') })));
  assert.strictEqual(res.done.length, 1000);
  assert.ok(writes <= 12, 'journal written ' + writes + ' times');
  assert.ok(stats <= 3 * 1000 + 10, stats + ' stats for 1000 files');
  assert.strictEqual(JSON.parse(fs.readFileSync(j, 'utf8')).finished, true);
});

// ── journal ────────────────────────────────────────────────────────────────
t('the journal is on disk before the first file is touched, and closed at the end', () => {
  const d = tmpdir(); const j = path.join(tmpdir(), 'journal.json'); const files = mkfiles(d, 3);
  let atFirst = null;
  const e = createEngine({ journalPath: j, fs: faultyFs((n, a) => {
    if (atFirst === null && !a.endsWith('.part')) atFirst = JSON.parse(fs.readFileSync(j, 'utf8'));
  }) });
  e.renameBatch(files.map(f => ({ from: f, to: withSuffix(f, '_V2') })));
  assert.ok(atFirst && atFirst.finished === false && atFirst.ops.length === 3, 'journal missing before the first rename');
  const end = JSON.parse(fs.readFileSync(j, 'utf8'));
  assert.strictEqual(end.finished, true); assert.ok(end.ops.every(o => o.state === 'done'));
});

t('the journal lives outside the renamed folder', () => {
  const d = tmpdir(); const j = path.join(tmpdir(), 'journal.json'); const files = mkfiles(d, 2);
  createEngine({ journalPath: j }).renameBatch(files.map(f => ({ from: f, to: withSuffix(f, '_V2') })));
  assert.ok(names(d).every(n => /_V2\.mov$/.test(n)), 'something was written into the user folder');
});

// ── the code itself ────────────────────────────────────────────────────────
t('no delete, copy, truncate or write call on user files anywhere in the app', () => {
  const src = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
  const forbidden = /\b(unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|truncate|truncateSync|ftruncate|copyFile|copyFileSync|cp|cpSync|appendFile|appendFileSync|createWriteStream)\s*\(/;
  for (const f of ['main.js', 'preload.js', 'rename-engine.js', 'volumes-linux.js']) {
    const code = src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const m = code.match(forbidden);
    assert.ok(!m, f + ' calls ' + (m && m[1]));
  }
  // writeFileSync only for the journal, which lives in the app's data folder
  const eng = src('rename-engine.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const writes = eng.match(/writeFileSync\([^)]*\)/g) || [];
  assert.ok(writes.length === 1 && /journalPath \+ '\.part'/.test(writes[0]), 'unexpected write: ' + writes.join(' | '));
  // main.js renames nothing itself: everything goes through the engine
  const main = src('main.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\brenameSync\s*\(|\brename\s*\(/.test(main), 'main.js renames files outside the engine');
});

console.log(passed + ' safety checks passed' + (process.exitCode ? ' — with failures above' : ''));
