/*
 * renamo - Batch rename files and folders with a live preview.
 * Copyright (C) 2026 just edit
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/*
 * THE RENAME ENGINE
 * =================
 * renamo must NEVER lose a file, whatever happens. This module is the only
 * place that touches the user's files, and it follows four rules:
 *
 *   1. It only ever calls rename. No delete, no copy, no write, no truncate
 *      on a user path - test/safety.test.js fails if one of those appears.
 *   2. It never overwrites. Right before every rename the target must be
 *      free, both by stat and by the folder listing (case and accents
 *      compared loosely, because NAS and macOS disagree on both). A name that
 *      differs only by case or accents is accepted only when it is provably
 *      the same file (same inode, and no other entry of that exact name).
 *   3. It never hides a file. No new name may start with a dot. A temporary
 *      name is used only when two files of the batch swap or chain their
 *      names, and it is visible and keeps the original name:
 *      "clip.mov.renamo-tmp". The plain case - adding a suffix, a prefix, a
 *      date - is a single direct rename per file.
 *   4. It checks every rename and stops at the first anomaly. If a renamed
 *      file cannot be found under its new name, or its size changed, the
 *      batch halts before touching anything else, and says exactly where
 *      each file is.
 *
 * Every request is validated here too - a file is only ever renamed inside
 * its own folder - so nothing that reaches the engine can move a file
 * elsewhere, whatever the caller sends.
 *
 * The batch is also written to a journal outside the user's folders, so an
 * interrupted batch is reported after a crash or a power cut.
 */
'use strict';
const path = require('path');
const nodeFs = require('fs');

const TMP_SUFFIX = '.renamo-tmp';
// The format used up to 1.6.2: hidden, and without the original name.
const LEGACY_TMP = /^\.renamo_tmp_(\d+)_(\d+)_(\d+)$/;
// "clip.mov.renamo-tmp", "clip.mov.renamo-tmp-3", and a suffix repeated by a
// batch that ran over an earlier leftover: all of them go back to "clip.mov".
const TMP_RE = /^(.+?)(?:\.renamo-tmp(?:-\d+)?)+$/;

const loose = s => String(s).normalize('NFC').toLowerCase();

// Names Windows refuses. Checked only when running on Windows: there the
// rename would fail anyway, this just says why before touching anything.
const WIN_BAD_CHARS = /[<>:"|?*\u0000-\u001f]/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

// The journal is a safety net: rewritten every JOURNAL_EVERY operations or
// JOURNAL_MS milliseconds, plus before the first rename and at the very end.
// Rewriting it after every single file made a 10 000-file batch write 16 GB.
const JOURNAL_EVERY = 200;
const JOURNAL_MS = 1000;

function createEngine(opts = {}) {
  const fs = opts.fs || nodeFs;
  const journalPath = opts.journalPath || null;
  const now = opts.now || (() => Date.now());
  const platform = opts.platform || process.platform;

  function statOrNull(p) {
    try { return fs.lstatSync(p); }
    catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null; throw e; }
  }
  // Where is this file? For reports only: an unreadable path counts as unknown.
  function where(p) {
    if (!p) return null;
    try { return statOrNull(p) ? p : null; } catch (e) { return null; }
  }

  // Two stats of the same file? The inode says it; when a volume does not
  // provide one, everything else about the file has to match.
  function sameFile(a, b) {
    if (!a || !b) return false;
    if (a.ino && b.ino) return a.ino === b.ino && a.dev === b.dev;
    return a.size === b.size && a.mtimeMs === b.mtimeMs && a.birthtimeMs === b.birthtimeMs && a.mode === b.mode;
  }

  // One index per folder, read once per batch and kept in step with our own
  // renames: the exact names, and the names compared loosely.
  const listings = new Map();
  function listing(dir) {
    if (!listings.has(dir)) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { names = []; }
      listings.set(dir, { exact: new Set(names), loose: new Set(names.map(loose)) });
    }
    return listings.get(dir);
  }
  function noteRename(from, to) {
    const l = listing(path.dirname(from));
    const fb = path.basename(from), tb = path.basename(to);
    l.exact.delete(fb); l.loose.delete(loose(fb));
    l.exact.add(tb); l.loose.add(loose(tb));
  }

  /*
   * Is `target` free for `source`?
   * - Same name apart from case or accents, same folder: free only if it is
   *   the very same file. On a volume that tells case apart (Linux, a NAS,
   *   case-sensitive APFS) "a.txt" and "A.txt" are two files.
   * - Otherwise: nothing may answer to that name, by stat or by listing.
   * `quick` skips the stat and trusts the listing read at the start of the
   * batch; the stat is then made right before the rename itself.
   */
  function isFree(target, source, quick) {
    const dir = path.dirname(target), tb = path.basename(target);
    const l = listing(dir);
    if (source && path.dirname(source) === dir && loose(tb) === loose(path.basename(source))) {
      const sb = path.basename(source);
      if (tb === sb) return true;
      if (l.exact.has(tb)) return false;           // another entry has exactly that name
      const t = statOrNull(target);
      if (!t) return true;
      return sameFile(statOrNull(source), t);
    }
    if (!quick && statOrNull(target)) return false;
    return !l.loose.has(loose(tb));
  }

  function tempNameFor(from) {
    const dir = path.dirname(from), base = path.basename(from);
    for (let n = 0; n < 1000; n++) {
      const cand = path.join(dir, base + TMP_SUFFIX + (n ? '-' + n : ''));
      if (isFree(cand, null)) return cand;
    }
    return null;
  }

  // What is wrong with this request, if anything. null = fine.
  function checkPair(p) {
    if (!p || typeof p.from !== 'string' || typeof p.to !== 'string' || !p.from || !p.to) return 'invalid request';
    if (!path.isAbsolute(p.from) || !path.isAbsolute(p.to)) return 'invalid path';
    if (path.dirname(p.from) !== path.dirname(p.to)) return 'a file can only be renamed inside its own folder';
    const b = path.basename(p.to);
    if (!b || b === '.' || b === '..' || /[\\/\u0000]/.test(b)) return 'invalid name';
    if (b.startsWith('.') && !path.basename(p.from).startsWith('.')) return 'the new name starts with a dot: the file would be hidden';
    if (Buffer.byteLength(b, 'utf8') > 255) return 'the new name is too long';
    if (platform === 'win32') {
      if (WIN_BAD_CHARS.test(b)) return 'Windows does not allow < > : " | ? * in a name';
      if (/[ .]$/.test(b)) return 'Windows does not allow a name ending with a space or a dot';
      if (WIN_RESERVED.test(b)) return 'this name is reserved by Windows';
    }
    return null;
  }

  // ── journal (outside the user's folders) ──────────────────────────────────
  let journal = null, journalDirty = 0, journalAt = 0;
  function saveJournal(force) {
    if (!journalPath || !journal) return;
    journalDirty++;
    if (!force && journalDirty < JOURNAL_EVERY && Date.now() - journalAt < JOURNAL_MS) return;
    journalDirty = 0; journalAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(journalPath), { recursive: true });
      fs.writeFileSync(journalPath + '.part', JSON.stringify(journal));
      fs.renameSync(journalPath + '.part', journalPath);
    } catch (e) { /* the journal is a safety net; never let it block a rename */ }
  }

  /*
   * Rename one file, never over something, never to a hidden name, and prove
   * it happened. On a failed check the error carries `at`: where the file is
   * now, as far as can be told (null when it cannot be found).
   */
  function safeRename(from, to, fromStat) {
    if (path.basename(to).startsWith('.') && !path.basename(from).startsWith('.')) {
      const e = new Error('the new name would hide the file'); e.code = 'EHIDDEN'; throw e;
    }
    if (!isFree(to, from)) { const e = new Error('target already exists'); e.code = 'EEXIST'; throw e; }
    fs.renameSync(from, to);
    let after = null;
    try { after = statOrNull(to); } catch (e) { after = null; }
    if (!after) {
      const e = new Error('the file could not be found under its new name after renaming');
      e.code = 'EVERIFY'; e.at = where(from); throw e;
    }
    if (fromStat && !fromStat.isDirectory() && after.size !== fromStat.size) {
      const e = new Error('renamed, but its size read back differs - check this file');
      e.code = 'EVERIFY'; e.at = to; throw e;
    }
    noteRename(from, to);
  }

  /*
   * pairs: [{ from, to }] absolute paths, each pair inside one folder.
   * Returns { ok, done, failed, undo, halted }.
   *   failed[i] = { from, to, error, now }  - `now` is where the file is.
   */
  function renameBatch(pairs) {
    listings.clear();
    const done = [], failed = [], undo = [];
    let halted = false;
    if (!Array.isArray(pairs)) pairs = [];

    // Pre-flight: every request valid, every source there, every target free
    // (apart from names that other files of the batch are about to leave).
    // Nothing is touched until this pass is over.
    const items = [];
    const valid = [];
    for (const p of pairs) {
      const bad = checkPair(p);
      if (bad) {
        const from = p && typeof p.from === 'string' ? p.from : '';
        failed.push({ from, to: p && typeof p.to === 'string' ? p.to : '', error: bad, now: where(from) });
      } else valid.push(p);
    }
    const leaving = new Set(valid.map(p => loose(p.from)));
    const targets = new Set();
    for (const p of valid) {
      let st;
      try { st = statOrNull(p.from); }
      catch (e) { failed.push({ from: p.from, to: p.to, error: 'the file cannot be read (' + (e.code || e.message) + ')', now: null }); continue; }
      if (!st) { failed.push({ from: p.from, to: p.to, error: 'the file is no longer there', now: null }); continue; }
      const key = loose(p.to);
      if (targets.has(key)) { failed.push({ from: p.from, to: p.to, error: 'two files would get the same name', now: p.from }); continue; }
      const freedByBatch = leaving.has(key) && key !== loose(p.from);
      let free = freedByBatch;
      if (!free) {
        try { free = isFree(p.to, p.from, true); }
        catch (e) { failed.push({ from: p.from, to: p.to, error: 'the folder cannot be read (' + (e.code || e.message) + ')', now: p.from }); continue; }
      }
      if (!free) { failed.push({ from: p.from, to: p.to, error: 'a file with this name already exists', now: p.from }); continue; }
      targets.add(key);
      items.push({ k: items.length, from: p.from, to: p.to, stat: st, tmp: null, state: 'planned', note: null });
    }

    // A file only needs a temporary name if its current name is the target
    // of another file of the batch (swaps and chains). Otherwise: direct.
    const wanted = new Set(items.map(i => loose(i.to)));
    const blockers = items.filter(i => wanted.has(loose(i.from)) && loose(i.from) !== loose(i.to));

    journal = { version: 2, startedAt: now(), finished: false,
      ops: items.map(i => ({ from: i.from, to: i.to, tmp: null, state: 'planned' })) };
    saveJournal(true);
    const jop = it => journal.ops[it.k];

    // Phase 1: step the blockers aside, under a visible name that keeps theirs.
    for (const it of blockers) {
      let tmp = null;
      try {
        tmp = tempNameFor(it.from);
        if (!tmp) throw new Error('no free temporary name');
        safeRename(it.from, tmp, it.stat);
        it.tmp = tmp; it.state = 'temp';
        Object.assign(jop(it), { tmp, state: 'temp' }); saveJournal(true);
      } catch (err) {
        if (err.code === 'EVERIFY') {
          halted = true;
          if (err.at === tmp) {                 // it moved: the put-back pass below brings it home
            it.tmp = tmp; it.state = 'temp'; it.note = err.message;
            Object.assign(jop(it), { tmp, state: 'temp' }); saveJournal(true);
            break;
          }
        }
        it.state = 'failed';
        failed.push({ from: it.from, to: it.to, error: String(err.message || err), now: err.code === 'EVERIFY' ? (err.at || null) : where(it.from) });
        Object.assign(jop(it), { state: 'failed' }); saveJournal(true);
        if (halted) break;
      }
    }

    // Phase 2: every file to its final name. Stop at the first anomaly.
    for (const it of items) {
      if (halted) break;
      if (it.state !== 'planned' && it.state !== 'temp') continue;
      const src = it.tmp || it.from;
      try {
        safeRename(src, it.to, it.stat);
        it.state = 'done';
        done.push({ from: it.from, to: it.to });
        undo.push({ from: it.to, to: it.from });
        Object.assign(jop(it), { state: 'done' }); saveJournal();
      } catch (err) {
        let nowAt;
        if (err.code === 'EVERIFY') {
          halted = true;
          nowAt = err.at || where(it.to) || null;
          if (nowAt === it.to) {
            // The rename did happen: it can be undone like the others.
            undo.push({ from: it.to, to: it.from });
          }
        } else nowAt = where(src);
        // A file waiting under its temporary name goes back to its own name,
        // if that name is still free. Never over anything.
        if (it.tmp && nowAt === it.tmp) {
          try { safeRename(it.tmp, it.from, it.stat); nowAt = it.from; }
          catch (e2) { nowAt = where(it.tmp) || where(it.from); }
        }
        it.state = 'failed';
        failed.push({ from: it.from, to: it.to, error: String(err.message || err), now: nowAt });
        Object.assign(jop(it), { state: nowAt === it.to ? 'unverified' : nowAt === it.tmp ? 'stuck' : 'failed' }); saveJournal(true);
      }
    }

    // Files set aside in phase 1 but never reached (halted batch): put them back.
    for (const it of items) {
      if (it.state !== 'temp') continue;
      let nowAt = it.tmp;
      try { safeRename(it.tmp, it.from, it.stat); nowAt = it.from; }
      catch (e) { nowAt = where(it.tmp) || where(it.from); }
      failed.push({ from: it.from, to: it.to, error: it.note || 'batch stopped before this file', now: nowAt });
      Object.assign(jop(it), { state: nowAt === it.tmp ? 'stuck' : 'failed' });
    }
    // Files never reached in phase 2 because the batch halted.
    for (const it of items) {
      if (it.state === 'planned') failed.push({ from: it.from, to: it.to, error: 'batch stopped before this file', now: where(it.from) });
    }

    journal.finished = true;
    journal.finishedAt = now();
    saveJournal(true);
    return { ok: failed.length === 0, done, failed, undo, halted };
  }

  // ── leftovers from interrupted batches ────────────────────────────────────
  // From a listing already in hand (hidden names included).
  function leftoversFrom(dir, names) {
    const out = [];
    for (const n of names || []) {
      const legacy = n.match(LEGACY_TMP);
      const cur = !legacy && n.match(TMP_RE);
      if (!legacy && !cur) continue;
      const full = path.join(dir, n);
      let st = null;
      try { st = statOrNull(full); } catch (e) { st = null; }
      if (!st) continue;
      out.push({ name: n, path: full, size: st.size, mtimeMs: st.mtimeMs,
        kind: legacy ? 'legacy' : 'temp',
        original: cur ? cur[1] : null,
        batch: legacy ? legacy[3] : null, index: legacy ? Number(legacy[2]) : null });
    }
    out.sort((a, b) => (a.batch || '').localeCompare(b.batch || '') || (a.index || 0) - (b.index || 0) || a.name.localeCompare(b.name));
    return out;
  }
  function findLeftovers(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    return leftoversFrom(dir, names);
  }

  // Guess an extension from the first bytes (reading only).
  function sniffExt(p) {
    let b;
    try {
      const fd = fs.openSync(p, 'r');
      try { b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); } finally { fs.closeSync(fd); }
    } catch (e) { return ''; }
    const s = (o, n) => b.toString('latin1', o, o + n);
    if (s(4, 4) === 'ftyp') {
      const brand = s(8, 4);
      if (brand === 'qt  ') return 'mov';
      if (brand === 'crx ') return 'cr3';
      if (brand.startsWith('M4A')) return 'm4a';
      return 'mp4';
    }
    if (['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(s(4, 4))) return 'mov';
    if (b[0] === 0x06 && b[1] === 0x0e && b[2] === 0x2b && b[3] === 0x34) return 'mxf';
    if (s(0, 4) === 'RIFF') return s(8, 4) === 'WAVE' ? 'wav' : s(8, 4) === 'AVI ' ? 'avi' : '';
    if (s(0, 4) === 'FORM' && s(8, 4).startsWith('AIF')) return 'aif';
    if (s(4, 3) === 'RED') return 'r3d';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (s(1, 3) === 'PNG') return 'png';
    if (s(0, 4) === '%PDF') return 'pdf';
    if (s(0, 3) === 'ID3') return 'mp3';
    if (s(0, 4) === 'II*\u0000' || s(0, 4) === 'MM\u0000*') return 'tif';
    if (s(0, 2) === 'PK') return 'zip';
    if (s(0, 5) === '<?xml') return 'xml';
    return '';
  }

  // First free name among "clip_RECOVERED.mov", "clip_RECOVERED_2.mov"...
  function recoveredName(dir, original) {
    const dot = original.lastIndexOf('.');
    const base = dot > 0 ? original.slice(0, dot) : original;
    const ext = dot > 0 ? original.slice(dot) : '';
    for (let n = 1; n < 1000; n++) {
      const cand = path.join(dir, base + '_RECOVERED' + (n > 1 ? '_' + n : '') + ext);
      if (isFree(cand, null)) return cand;
    }
    return null;
  }

  /*
   * Bring leftovers back into view. Temporary files of the current format
   * return to their original name - or, if someone has taken that name since,
   * to "<name>_RECOVERED.<ext>". Hidden files of the old format lost their
   * name, so they become RECOVERED_<n>.<ext>, in the order of the batch.
   * Only renames, never over anything.
   */
  function recoverLeftovers(dir) {
    listings.clear();
    const restored = [], failed = [];
    for (const f of findLeftovers(dir)) {
      let target;
      try {
        if (f.kind === 'temp') {
          target = path.join(dir, f.original);
          if (f.original.startsWith('.') || !isFree(target, f.path)) target = recoveredName(dir, f.original.replace(/^\.+/, '') || 'file');
        } else {
          const ext = sniffExt(f.path);
          const base = 'RECOVERED_' + String(f.index + 1).padStart(3, '0');
          target = path.join(dir, base + (ext ? '.' + ext : ''));
          if (!isFree(target, null)) target = path.join(dir, base + '_' + f.batch + (ext ? '.' + ext : ''));
        }
        if (!target) throw new Error('no free name to bring it back under');
        safeRename(f.path, target, statOrNull(f.path));
        restored.push({ from: f.path, to: target });
      } catch (e) { failed.push({ from: f.path, to: target || f.path, error: String(e.message || e) }); }
    }
    return { restored, failed };
  }

  function readJournal() {
    if (!journalPath) return null;
    try { return JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch (e) { return null; }
  }

  return { renameBatch, findLeftovers, leftoversFrom, recoverLeftovers, sniffExt, readJournal, checkPair, TMP_SUFFIX };
}

module.exports = { createEngine, TMP_SUFFIX, LEGACY_TMP, TMP_RE };
