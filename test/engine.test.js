/*
 * renamo - rename engine tests
 *
 * The renderer lives in src/index.html. The naming rules sit between the
 * ENGINE-START / ENGINE-END markers and touch no DOM, so this file lifts that
 * block out and runs it in a plain Node context.
 *
 *   node test/engine.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const start = html.indexOf('ENGINE-START');
const end = html.indexOf('// ENGINE-END');
assert.ok(start > 0 && end > start, 'ENGINE-START / ENGINE-END markers not found in src/index.html');
const src = html.slice(html.indexOf('\n', start) + 1, end);

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { buildName, applyCase, cleanStr, compileRegex, splitName } = ctx;

// Every rule off by default; each test switches on only what it needs.
function S(over){
  const base = {
    clean: { on: false },
    regex: { on: false, pattern: '', replaceWith: '', ignoreCase: false },
    case: { on: false, mode: 'lower' },
    insert: { on: false, str: '', pos: 1, dir: 'start' },
    add: { on: false, prefix: '', suffix: '' },
    remove: { on: false, str: '', first: 0, last: 0 },
    replace: { on: false, search: '', replaceWith: '', matchCase: false },
    extension: { on: false, mode: 'lower', newExt: '' },
    datetime: { on: false, source: 'now', fmt: 'YYYY-MM-DD', position: 'start' },
    numbering: { on: false, start: 1, increment: 1, padding: 3, sep: '_', position: 'end' },
  };
  for (const k of Object.keys(over || {})) base[k] = Object.assign({}, base[k], over[k]);
  return base;
}
const file = (name, extra) => Object.assign({ name, isDir: false, birthtimeMs: 0, mtimeMs: 0 }, extra || {});

let passed = 0;
function t(label, fn){
  try { fn(); passed++; }
  catch (err) { console.error('FAIL  ' + label + '\n      ' + err.message); process.exitCode = 1; }
}

// ── splitName ──────────────────────────────────────────────────────────────
t('splitName keeps a dotfile whole', () => {
  assert.strictEqual(JSON.stringify(splitName('.hidden', false)), JSON.stringify({ base: '.hidden', ext: '' }));
});
t('splitName never splits a folder', () => {
  assert.strictEqual(JSON.stringify(splitName('archive.2024', true)), JSON.stringify({ base: 'archive.2024', ext: '' }));
});

// ── CASE ───────────────────────────────────────────────────────────────────
t('CASE lowercase', () => assert.strictEqual(applyCase('Rush_A01.MOV', 'lower'), 'rush_a01.mov'));
t('CASE uppercase', () => assert.strictEqual(applyCase('rush a01', 'upper'), 'RUSH A01'));
t('CASE title on spaces, underscores and dashes', () => {
  assert.strictEqual(applyCase('interview jean-marc_final', 'title'), 'Interview Jean-Marc_Final');
});
t('CASE sentence keeps the rest lowercase', () => {
  assert.strictEqual(applyCase('RUSH camera A', 'sentence'), 'Rush camera a');
});
t('CASE sentence skips leading digits', () => {
  assert.strictEqual(applyCase('01 PLAN large', 'sentence'), '01 Plan large');
});
t('CASE is applied to the base name only', () => {
  assert.strictEqual(buildName(file('Rush_A01.MOV'), 0, S({ case: { on: true, mode: 'lower' } })), 'rush_a01.MOV');
});

// ── REGEX ──────────────────────────────────────────────────────────────────
t('REGEX swaps capture groups', () => {
  const s = S({ regex: { on: true, pattern: '(\\d{4})-(\\d{2})-(\\d{2})', replaceWith: '$3$2$1' } });
  assert.strictEqual(buildName(file('2026-08-19_plan.mov'), 0, s), '19082026_plan.mov');
});
t('REGEX is case sensitive by default', () => {
  const s = S({ regex: { on: true, pattern: 'cam', replaceWith: 'X' } });
  assert.strictEqual(buildName(file('CAM_cam.mov'), 0, s), 'CAM_X.mov');
});
t('REGEX ignore case hits both', () => {
  const s = S({ regex: { on: true, pattern: 'cam', replaceWith: 'X', ignoreCase: true } });
  assert.strictEqual(buildName(file('CAM_cam.mov'), 0, s), 'X_X.mov');
});
t('REGEX is global', () => {
  const s = S({ regex: { on: true, pattern: '_', replaceWith: '-' } });
  assert.strictEqual(buildName(file('a_b_c.mov'), 0, s), 'a-b-c.mov');
});
t('an invalid pattern compiles to null and is skipped', () => {
  assert.strictEqual(compileRegex('([a-z', false), null);
  const s = S({ regex: { on: true, pattern: '([a-z', replaceWith: 'X' } });
  assert.strictEqual(buildName(file('keepme.mov'), 0, s), 'keepme.mov');
});
t('REGEX leaves the extension alone', () => {
  const s = S({ regex: { on: true, pattern: 'mov', replaceWith: 'X', ignoreCase: true } });
  assert.strictEqual(buildName(file('mov_take.mov'), 0, s), 'X_take.mov');
});
t('a regex object is reused across rows without drifting (lastIndex reset)', () => {
  const s = S({ regex: { on: true, pattern: 'a', replaceWith: 'X' } });
  s.regex.compiled = compileRegex('a', false);
  const names = ['aaa.mov', 'aaa.mov', 'aaa.mov'].map(n => buildName(file(n), 0, s));
  assert.deepStrictEqual(names, ['XXX.mov', 'XXX.mov', 'XXX.mov']);
});

// ── rule order: REGEX then CASE then ADD ───────────────────────────────────
t('CASE runs after REGEX but before ADD', () => {
  const s = S({
    regex: { on: true, pattern: '\\s+', replaceWith: '_' },
    case: { on: true, mode: 'lower' },
    add: { on: true, prefix: 'JE_', suffix: '' },
  });
  assert.strictEqual(buildName(file('PLAN Large 01.MOV'), 0, s), 'JE_plan_large_01.MOV');
});
t('CLEAN still runs last on the base name', () => {
  const s = S({ case: { on: true, mode: 'title' }, clean: { on: true } });
  assert.strictEqual(buildName(file('éric à paris.mov'), 0, s), 'Eric_A_Paris.mov');
});

// ── regressions on the existing rules ──────────────────────────────────────
t('numbering uses the row index', () => {
  const s = S({ numbering: { on: true, start: 1, increment: 1, padding: 3, sep: '_', position: 'end' } });
  assert.strictEqual(buildName(file('a.mov'), 0, s), 'a_001.mov');
  assert.strictEqual(buildName(file('b.mov'), 4, s), 'b_005.mov');
});
t('date from the modified timestamp', () => {
  const d = new Date(2026, 7, 19, 10, 30, 0);
  const s = S({ datetime: { on: true, source: 'modified', fmt: 'YYYY-MM-DD', position: 'start' } });
  assert.strictEqual(buildName(file('plan.mov', { mtimeMs: d.getTime() }), 0, s), '2026-08-19_plan.mov');
});
t('extension replace', () => {
  const s = S({ extension: { on: true, mode: 'replace', newExt: '.MP4' } });
  assert.strictEqual(buildName(file('a.mov'), 0, s), 'a.MP4');
});
t('separators are stripped from the result', () => {
  const s = S({ add: { on: true, prefix: 'a/b\\c_', suffix: '' } });
  assert.strictEqual(buildName(file('x.mov'), 0, s), 'abc_x.mov');
});
t('CLEAN strips accents and spaces', () => {
  assert.strictEqual(cleanStr('Été à Paris (final)'), 'Ete_a_Paris_final');
});

console.log(passed + ' checks passed' + (process.exitCode ? ' — with failures above' : ''));
