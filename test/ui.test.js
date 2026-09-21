/*
 * renamo - UI charter checks
 *
 * The look follows the shared UI charter (see the "CHARTE UI NOAR" block at the
 * end of the stylesheet in src/index.html). These checks cover what the charter
 * promises and what could regress silently: they read the file, no browser.
 *
 *   node test/ui.test.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const css = html.slice(0, html.indexOf('</style>'));
const blockStart = css.indexOf('CHARTE UI NOAR');
const block = blockStart >= 0 ? css.slice(blockStart) : '';
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [, ''])[1];

let passed = 0;
function t(label, fn){
  try { fn(); passed++; }
  catch (err) { console.error('FAIL  ' + label + '\n      ' + err.message); process.exitCode = 1; }
}
const tagOf = id => {
  const m = html.match(new RegExp('<[a-z]+[^>]*\\bid="' + id + '"[^>]*>'));
  assert.ok(m, 'element #' + id + ' not found');
  return m[0];
};

t('the charter block sits inside the stylesheet', () => {
  assert.ok(blockStart > 0, 'no "CHARTE UI NOAR" block before </style>');
});

t('surfaces and state colours carry the charter values', () => {
  const want = {
    '--page': '#0a0b0e', '--card': '#14161c', '--ins': '#0e1014', '--raise': '#1b1d24',
    '--green': '#35c98b', '--red': '#f2555a', '--blue': '#4d90f0', '--orange': '#f2a03d',
  };
  for (const [k, v] of Object.entries(want)) {
    assert.ok(new RegExp(k + ':' + v + '\\b').test(block), k + ' should be ' + v);
  }
});

t('structural border tokens are switched off', () => {
  for (const k of ['--bd', '--bd2', '--bd3']) {
    assert.ok(new RegExp(k + ':transparent').test(block), k + ' should be transparent');
  }
});

t('every icon-only button has an aria-label', () => {
  for (const id of ['btn-up', 'sort-dir', 'flt-clear', 'disks-refresh', 'wc-min', 'wc-max', 'wc-close', 'chk-all']) {
    assert.ok(/aria-label="[^"]+"/.test(tagOf(id)), '#' + id + ' has no aria-label');
  }
});

// renamo keeps its disk-column handle (decided exception to the charter), but it
// must stay neutral: visible only on hover/drag, never in the accent colour.
t('the disk-column handle is kept, and drawn without the accent', () => {
  assert.ok(!/#resizer\{display:none/.test(block), 'the resizer was hidden again');
  const rules = block.match(/#resizer[^{]*\{[^}]*\}/g) || [];
  assert.ok(rules.length > 0, 'no #resizer rule in the charter block');
  assert.ok(rules.every(r => !/--accent/.test(r)), 'the resizer uses the accent');
  assert.ok(!/#sidebar\{width:[^;]*!important/.test(block), 'a !important width would block the drag');
});

t('the accent is never used to mark a state', () => {
  const stateRules = ['.tnode.sel', '.row.sel', '.cbox.on', '.sw.on', '.seg span.active'];
  for (const sel of stateRules) {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{]*\\{[^}]*var\\(--accent\\)');
    assert.ok(!re.test(block), sel + ' uses the accent');
  }
});

t('the part of the name that changes is shown in green', () => {
  assert.ok(/\.row \.nw \.chg[^{]*\{[^}]*color:var\(--green\)/.test(block));
});

t('a conflict is shown in red', () => {
  assert.ok(/\.row\.conflict \.nw\{color:var\(--red\)/.test(block));
});

t('footer counts use the badge template with the right colours', () => {
  assert.ok(/badge b-green">'\+okCount/.test(script), 'TO RENAME is not a green badge');
  assert.ok(/badge b-red">'\+conflicts/.test(script), 'CONFLICT is not a red badge');
  assert.ok(/badge b-orange">'\+hidden/.test(script), 'HIDDEN is not an orange badge');
});

t('Escape closes the About window', () => {
  const about = script.slice(script.indexOf('function showAbout'), script.indexOf('function showAbout') + 3000);
  assert.ok(/e\.key==='Escape'\)\{[^}]*dismiss\(\)/.test(about), 'showAbout does not close on Escape');
});

t("renamo's accent is its icon colour, Sapin, never the state green", () => {
  assert.ok(/--accent:#3f9a6f\b/.test(block), 'accent should be Sapin #3f9a6f');
  assert.ok(!/--accent:#35c98b/.test(block), 'the accent must not be the state green');
});

t('the main action uses the tinted green of the charter', () => {
  assert.ok(/#btn-rename\{[^}]*background:#0f2c1d/.test(block));
});

console.log(passed + ' charter checks passed' + (process.exitCode ? ' — with failures above' : ''));
