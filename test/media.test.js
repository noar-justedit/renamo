/*
 * renamo - video information tests (src/media-info.js), on small real clips
 * made with ffmpeg (test/fixtures).
 *
 *   node test/media.test.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { readMediaInfo, cancelMediaReads, summarize, parseMediaDate, clipsAnalyzed } = require('../src/media-info');
const os = require('os');

const fx = n => path.join(__dirname, 'fixtures', n);
let passed = 0;
async function t(label, fn) {
  try { await fn(); passed++; }
  catch (err) { console.error('FAIL  ' + label + '\n      ' + err.message); process.exitCode = 1; }
}

(async () => {
  await t('UHD H.264 MP4: 3840x2160, 25 fps, AVC, recording date', async () => {
    const { info } = await readMediaInfo(fx('uhd25.mp4'));
    assert.deepStrictEqual({ w: info.width, h: info.height, fps: info.fps, codec: info.codec },
      { w: 3840, h: 2160, fps: 25, codec: 'AVC' });
    assert.strictEqual(info.shotMs, new Date(2026, 10, 13, 9, 12, 33).getTime(), 'the time as written in the clip');
  });
  await t('HD MOV at 23.976', async () => {
    const { info } = await readMediaInfo(fx('hd2398.mov'));
    assert.strictEqual(info.width, 1920); assert.strictEqual(info.height, 1080);
    assert.ok(Math.abs(info.fps - 23.976) < 0.001);
  });
  await t('a sound file has no picture: no resolution, no guess', async () => {
    const { info } = await readMediaInfo(fx('audio.wav'));
    assert.strictEqual(info.width, null); assert.strictEqual(info.fps, null);
  });
  await t('a missing file is an error, not a crash', async () => {
    const r = await readMediaInfo(fx('nope.mov'));
    assert.ok(r.error && !r.info);
  });
  await t('reading leaves the clip untouched (same bytes, same date)', async () => {
    const p = fx('uhd25.mp4');
    const st = fs.statSync(p), bytes = fs.readFileSync(p);
    await readMediaInfo(p);
    assert.strictEqual(fs.statSync(p).mtimeMs, st.mtimeMs);
    assert.ok(fs.readFileSync(p).equals(bytes));
  });
  await t('dates are kept as written: no time zone conversion, whatever the computer', async () => {
    const local = (...a) => new Date(...a).getTime();
    assert.strictEqual(parseMediaDate('2026-11-13 09:12:33 UTC'), local(2026, 10, 13, 9, 12, 33));
    assert.strictEqual(parseMediaDate('UTC 2026-11-13 09:12:33'), local(2026, 10, 13, 9, 12, 33));
    assert.strictEqual(parseMediaDate('2026-11-14T00:30:00+04:00'), local(2026, 10, 14, 0, 30, 0), 'shot on the 14th stays the 14th');
    assert.strictEqual(parseMediaDate('2026-11-13T22:30:00.000+04:00'), local(2026, 10, 13, 22, 30, 0), 'fractions of a second');
    assert.strictEqual(parseMediaDate('2026-11-13'), local(2026, 10, 13));
    assert.strictEqual(parseMediaDate('1904-01-01 00:00:00 UTC'), null);
    assert.strictEqual(parseMediaDate(undefined), null);
  });
  await t('the recording date comes from Recorded_Date, else Encoded_Date, never Tagged_Date', async () => {
    const g = f => summarize({ media: { track: [Object.assign({ '@type': 'General' }, f)] } }).shotMs;
    assert.strictEqual(g({ Recorded_Date: '2026-01-02', Encoded_Date: '2026-05-05 UTC' }), new Date(2026, 0, 2).getTime());
    assert.strictEqual(g({ Encoded_Date: '2026-05-05 10:00:00 UTC' }), new Date(2026, 4, 5, 10).getTime());
    assert.strictEqual(g({ Tagged_Date: '2026-05-05 10:00:00 UTC' }), null);
  });
  await t('a renamed clip is not read again', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'renamo-media-'));
    const a = path.join(d, 'A001.mov'), b = path.join(d, 'A001_PROD.mov');
    fs.copyFileSync(fx('hd2398.mov'), a);
    await readMediaInfo(a);
    const before = clipsAnalyzed();
    fs.renameSync(a, b);
    const r = await readMediaInfo(b);
    assert.strictEqual(r.info.width, 1920);
    assert.strictEqual(clipsAnalyzed(), before, 'read again after a rename');
  });
  await t('files still waiting are dropped when another folder is opened', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'renamo-media-'));
    const ps = [1, 2, 3].map(i => { const p = path.join(d, 'C' + i + '.mov'); fs.copyFileSync(fx('uhd25.mp4'), p); return p; });
    const jobs = ps.map(p => readMediaInfo(p));
    cancelMediaReads();
    const res = await Promise.all(jobs);
    assert.ok(res.every(r => r.cancelled), JSON.stringify(res));
    const again = await readMediaInfo(ps[0]);
    assert.ok(again.info, 'a new request after the cancel is read');
  });
  console.log(passed + ' video information checks passed' + (process.exitCode ? ' — with failures above' : ''));
})();
