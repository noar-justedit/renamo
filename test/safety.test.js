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

t('recovery never overwrites an existing file either', () => {
  const d = tmpdir(); const [a] = mkfiles(d, 1);
  fs.renameSync(a, a + '.renamo-tmp'); write(d, path.basename(a), 'someone else took the name');
  const before = contents(d);
  const res = createEngine().recoverLeftovers(d);
  assert.strictEqual(res.restored.length, 0); assert.strictEqual(res.failed.length, 1);
  assert.deepStrictEqual(contents(d), before);
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
  for (const f of ['main.js', 'preload.js', 'rename-engine.js']) {
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
