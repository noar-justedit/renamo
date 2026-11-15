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
const { buildName, applyCase, cleanStr, compileRegex, splitName, nameProblem, compileTemplate, parentFolders, fmtDate, indexInFolder, presetToText, presetFromText, withPreset, presetNamed, cleanPreset } = ctx;

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
    template: { on: false, pattern: '', compiled: null },
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


// ── 1.6.4 ──────────────────────────────────────────────────────────────────
t('a rule that empties the name is refused: the file would be hidden', () => {
  const s = S({ remove: { on: true, first: 4 } });
  const nn = buildName(file('clip.mov'), 0, s);
  assert.strictEqual(nn, '.mov');
  assert.ok(/hidden/.test(nameProblem(nn)));
  assert.ok(nameProblem(buildName(file('Фото.jpg'), 0, S({ clean: { on: true } }))));
});
t('names Windows refuses are flagged', () => {
  for (const n of ['a:b.mov', 'what?.mov', 'x<y', 'end.', 'end ', 'CON', 'nul.txt', 'LPT1.mov']) assert.ok(nameProblem(n), n);
  for (const n of ['console.mov', 'A001C001_V2.mov', 'été.mov']) assert.strictEqual(nameProblem(n), null, n);
  assert.ok(nameProblem('é'.repeat(130) + '.mov'), 'a name over 255 bytes passed');
});
t('EXTENSION "Replace with" gives an extension to a file without one, never to a folder', () => {
  const s = S({ extension: { on: true, mode: 'replace', newExt: 'txt' } });
  assert.strictEqual(buildName(file('README'), 0, s), 'README.txt');
  assert.strictEqual(buildName({ name: 'Folder.2024', isDir: true }, 0, s), 'Folder.2024');
});
t('the new name comes out in NFC', () => {
  assert.strictEqual(buildName(file('Cafe\u0301.mov'), 0, S({ add: { on: true, suffix: '_e\u0301' } })), 'Caf\u00e9_\u00e9.mov');
});

// ── TEMPLATE ───────────────────────────────────────────────────────────────
const T = pattern => S({ template: { on: true, pattern, compiled: compileTemplate(pattern) } });
const notes = () => ({ missing: [], waiting: false });
const clip = (p, extra) => Object.assign({ name: p.split('/').pop(), path: p, isDir: false, birthtimeMs: 0, mtimeMs: 0 }, extra || {});
const nov13 = new Date(2026, 10, 13, 9, 7, 5).getTime();

t('date formats: YYYY YY MM DD HH hh mm ss, in one pass', () => {
  const d = new Date(2026, 10, 13, 9, 7, 5);
  assert.strictEqual(fmtDate(d, 'YYYYMMDD'), '20261113');
  assert.strictEqual(fmtDate(d, 'YYMMDD'), '261113');
  assert.strictEqual(fmtDate(d, 'YYYY-MM-DD_HHmmss'), '2026-11-13_090705');
  assert.strictEqual(fmtDate(d, 'hh-mm-ss'), '09-07-05');
});
t('folders above a file, nearest first, on Mac and Windows paths', () => {
  assert.deepStrictEqual([...parentFolders('/Volumes/NAS/20261113/CAM_A/CARTE_01/A001.mov')].slice(0, 3), ['CARTE_01', 'CAM_A', '20261113']);
  assert.deepStrictEqual([...parentFolders('D:\\RUSHES\\CAM_B\\B002.mxf')], ['CAM_B', 'RUSHES', 'D:']);
});
t('the production format: native name, code, date, camera, card, resolution', () => {
  const f = clip('/Volumes/NAS/20261113/CAM_A/CARTE_01/A001C003.mov', { _media: { width: 3840, height: 2160, fps: 25, codec: 'ProRes', shotMs: nov13 } });
  assert.strictEqual(buildName(f, 0, T('{name}_PROD042_{shot:YYYYMMDD}_{folder2}_{folder1}_{resolution}')),
    'A001C003_PROD042_20261113_CAM_A_CARTE_01_3840x2160.mov');
});
t('the date can sit anywhere, from the file dates too', () => {
  const f = clip('/x/A001.mov', { birthtimeMs: nov13, mtimeMs: nov13 });
  assert.strictEqual(buildName(f, 0, T('X_{created:YYMMDD}_{name}')), 'X_261113_A001.mov');
  assert.strictEqual(buildName(f, 0, T('{modified}')), '20261113.mov');
});
t('{name} is the name after the text rules, {original} the name as it was', () => {
  const s = T('{name}-{original}'); s.replace = { on: true, search: 'C003', replaceWith: '', matchCase: true };
  assert.strictEqual(buildName(clip('/x/A001C003.mov'), 0, s), 'A001-A001C003.mov');
});
t('{n:3} numbers in the order of the list', () => {
  assert.strictEqual(buildName(clip('/x/a.mov'), 4, T('SHOT_{n:3}')), 'SHOT_005.mov');
  assert.strictEqual(buildName(clip('/x/a.mov'), 4, T('{n}')), '5.mov');
});
t('fps keeps its decimals only when there are some', () => {
  assert.strictEqual(buildName(clip('/x/a.mov', { _media: { fps: 23.976023 } }), 0, T('{fps}')), '23.976.mov');
  assert.strictEqual(buildName(clip('/x/a.mov', { _media: { fps: 25 } }), 0, T('{fps}')), '25.mov');
});
t('a value the file does not have is reported, never guessed', () => {
  const n = notes();
  buildName(clip('/x/a.wav', { _media: null }), 0, T('{name}_{resolution}_{created}'), n);
  assert.deepStrictEqual([...n.missing], ['resolution', 'created']);
  const n2 = notes();
  buildName(clip('/a.mov'), 0, T('{folder2}'), n2);
  assert.deepStrictEqual([...n2.missing], ['folder2']);
  const n3 = notes();
  buildName(clip('D:\\RUSHES\\B002.mxf'), 0, T('{folder2}'), n3);
  assert.deepStrictEqual([...n3.missing], ['folder2'], 'a drive letter is not a folder name');
});
t('while the video information is being read, the name is marked as waiting', () => {
  const n = notes();
  buildName(clip('/x/a.mov'), 0, T('{resolution}'), n);
  assert.strictEqual(n.waiting, true);
  assert.strictEqual(compileTemplate('{resolution}').usesMedia, true);
  assert.strictEqual(compileTemplate('{name}_{folder1}').usesMedia, false);
});
t('an unknown tag or an unclosed brace is an error (the window then renames nothing)', () => {
  assert.ok(compileTemplate('{nmae}').error);
  assert.ok(compileTemplate('{folder}').error, '{folder} needs its number');
  assert.ok(compileTemplate('{name').error);
  assert.ok(compileTemplate('{n:abc}').error);
  const s = T('{nmae}_X');
  assert.strictEqual(buildName(clip('/x/a.mov'), 0, s), 'a.mov');
});
t('CASE, ADD and CLEAN still apply after the template; the extension stays', () => {
  const s = T('{folder1} {name}'); s.case = { on: true, mode: 'upper' }; s.clean = { on: true };
  assert.strictEqual(buildName(clip('/x/Card 1/a001.mov'), 0, s), 'CARD_1_A001.mov');
});
t('with subfolders, numbering starts again in each folder', () => {
  const items = ['/d/CARTE_01/a', '/d/CARTE_01/b', '/d/CARTE_01/c', '/d/CARTE_02/a', '/d/CARTE_02/b'].map(p => ({ dir: p.slice(0, p.lastIndexOf('/')) }));
  assert.deepStrictEqual([...indexInFolder(items)], [0, 1, 2, 0, 1]);
  const one = ['a', 'b', 'c'].map(() => ({ dir: '/d' }));
  assert.deepStrictEqual([...indexInFolder(one)], [0, 1, 2], 'one folder: as before');
});
t('a template that writes a folder separator cannot move the file', () => {
  assert.strictEqual(buildName(clip('/x/CAM/a.mov'), 0, T('{folder1}/{name}')), 'CAMa.mov');
});

// ── template presets ───────────────────────────────────────────────────────
t('a preset travels as one line of text and comes back the same', () => {
  const p = { name: 'PROD042 — "Poine"', template: '{name}_PROD042_{shot:YYYYMMDD}_{folder2}_{folder1}_{resolution}' };
  const text = presetToText(p);
  assert.ok(/^renamo-preset \{/.test(text) && !/\n/.test(text));
  assert.deepStrictEqual({ ...presetFromText(text) }, p);
});
t('a pasted preset survives the line breaks and spaces a mail adds', () => {
  const text = presetToText({ name: 'A', template: '{name}_X' });
  const mailed = '  ' + text.slice(0, 20) + '\r\n' + text.slice(20) + '\n ';
  assert.deepStrictEqual({ ...presetFromText(mailed) }, { name: 'A', template: '{name}_X' });
});
t('a mail that cuts the line at a space, or indents it, changes nothing', () => {
  const p = { name: 'PROD 042 Poine', template: '{name}_PROD 042  x' };
  const text = presetToText(p);
  assert.ok(!/ /.test(text.slice('renamo-preset '.length)), 'the shared line still holds spaces: ' + text);
  const cut = text.split('').map((c, i) => (i % 7 === 6 ? c + '\r\n    ' : c)).join('');
  assert.deepStrictEqual({ ...presetFromText(cut) }, p);
});
t('a preset typed by hand keeps the spaces inside its line', () => {
  assert.deepStrictEqual({ ...presetFromText('renamo-preset {"name":"Mariage Dupont","template":"{name} x"}') }, { name: 'Mariage Dupont', template: '{name} x' });
});
t('names and templates are kept in NFC and within their limits, the same way on save and on paste', () => {
  const long = 'x'.repeat(700);
  const viaSave = cleanPreset('  Cafe\u0301 ' + long, '{name}' + long);
  const viaPaste = presetFromText(presetToText({ name: '  Cafe\u0301 ' + long, template: '{name}' + long }));
  assert.deepStrictEqual({ ...viaPaste }, { ...viaSave });
  assert.ok(viaSave.name.startsWith('Caf\u00e9') && viaSave.name.length === 60 && viaSave.template.length === 500);
});
t('one preset per name, whatever the case or the accent form', () => {
  const l = withPreset(withPreset([], { name: 'Caf\u00e9', template: '1' }), { name: 'CAFE\u0301', template: '2' });
  assert.strictEqual(l.length, 1);
  assert.strictEqual(presetNamed(l, 'café').template, '2');
  assert.strictEqual(presetNamed(l, 'other'), null);
});
t('invisible and right-to-left characters are refused in a new name', () => {
  for (const c of ['\u200B', '\u200E', '\u202E', '\u2066', '\uFEFF']) assert.ok(nameProblem('A001_' + c + 'x.mov'), JSON.stringify(c));
  assert.strictEqual(nameProblem('A001_Café_日本.mov'), null);
});
t('anything else is not a preset', () => {
  for (const bad of ['', 'hello', '{name}_X', 'renamo-preset {oops', 'renamo-preset {"name":"","template":"x"}', 'renamo-preset {"name":"A"}', 'renamo-preset 42'])
    assert.strictEqual(presetFromText(bad), null, bad);
});
t('saving under an existing name replaces it (case ignored); the list stays sorted', () => {
  let l = withPreset([], { name: 'b', template: '1' });
  l = withPreset(l, { name: 'A', template: '2' });
  l = withPreset(l, { name: 'B', template: '3' });
  assert.deepStrictEqual(l.map(p => p.name + '=' + p.template), ['A=2', 'B=3']);
  assert.deepStrictEqual(withPreset([{ name: 'P10', template: 'x' }], { name: 'P9', template: 'y' }).map(p => p.name), ['P9', 'P10']);
});
console.log(passed + ' checks passed' + (process.exitCode ? ' — with failures above' : ''));
