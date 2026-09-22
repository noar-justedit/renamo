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
 *   2. It never overwrites. Before every rename the target must be free, both
 *      by stat and by the folder listing (case and accents compared loosely,
 *      because NAS and macOS disagree on both).
 *   3. It never hides a file. A temporary name is used only when two files of
 *      the batch swap or chain their names, and it is visible and keeps the
 *      original name: "clip.mov.renamo-tmp". The plain case - adding a
 *      suffix, a prefix, a date - is a single direct rename per file.
 *   4. It checks every rename and stops at the first anomaly. If a renamed
 *      file cannot be found under its new name, the batch halts before
 *      touching anything else, and says exactly where each file is.
 *
 * Every step is also written to a journal outside the user's folders, so an
 * interrupted batch can be put back after a crash or a power cut.
 */
'use strict';
const path = require('path');
const nodeFs = require('fs');

const TMP_SUFFIX = '.renamo-tmp';
// The format used up to 1.6.2: hidden, and without the original name.
const LEGACY_TMP = /^\.renamo_tmp_(\d+)_(\d+)_(\d+)$/;
const TMP_RE = /^(.*)\.renamo-tmp(?:-(\d+))?$/;

const loose = s => String(s).normalize('NFC').toLowerCase();

function createEngine(opts = {}) {
  const fs = opts.fs || nodeFs;
  const journalPath = opts.journalPath || null;
  const now = opts.now || (() => Date.now());

  function statOrNull(p) {
    try { return fs.lstatSync(p); }
    catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null; throw e; }
  }

  // One loose-name index per folder, kept in step with our own renames.
  const listings = new Map();
  function listing(dir) {
    if (!listings.has(dir)) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { names = []; }
      listings.set(dir, new Set(names.map(loose)));
    }
    return listings.get(dir);
  }
  function noteRename(from, to) {
    const d = path.dirname(from);
    const set = listing(d);
    set.delete(loose(path.basename(from)));
    set.add(loose(path.basename(to)));
  }

  // Is `target` free for `source`? The same file under another case or
  // accent form counts as free (that is a case-only rename of itself).
  function isFree(target, source) {
    const sameName = source && loose(path.basename(target)) === loose(path.basename(source))
      && path.dirname(target) === path.dirname(source);
    if (sameName) return true;
    if (statOrNull(target)) return false;
    return !listing(path.dirname(target)).has(loose(path.basename(target)));
  }

  function tempNameFor(from) {
    const dir = path.dirname(from), base = path.basename(from);
    for (let n = 0; n < 1000; n++) {
      const cand = path.join(dir, base + TMP_SUFFIX + (n ? '-' + n : ''));
      if (isFree(cand, null)) return cand;
    }
    return null;
  }

  // ── journal (outside the user's folders) ──────────────────────────────────
  let journal = null;
  function saveJournal() {
    if (!journalPath || !journal) return;
    try {
      fs.mkdirSync(path.dirname(journalPath), { recursive: true });
      fs.writeFileSync(journalPath + '.part', JSON.stringify(journal, null, 1));
      fs.renameSync(journalPath + '.part', journalPath);
    } catch (e) { /* the journal is a safety net; never let it block a rename */ }
  }

  // Rename one file, never over something, and prove it happened.
  function safeRename(from, to, fromStat) {
    if (!isFree(to, from)) { const e = new Error('target already exists'); e.code = 'EEXIST'; throw e; }
    fs.renameSync(from, to);
    const after = statOrNull(to);
    const lost = !after || (fromStat && !fromStat.isDirectory() && after.size !== fromStat.size);
    if (lost) {
      const e = new Error('the file could not be found under its new name after renaming');
      e.code = 'EVERIFY';
      throw e;
    }
    noteRename(from, to);
  }

  function where(p) { return statOrNull(p) ? p : null; }

  /*
   * pairs: [{ from, to }] absolute paths, each pair inside one folder.
   * Returns { ok, done, failed, undo, halted }.
   *   failed[i] = { from, to, error, now }  - `now` is where the file is.
   */
  function renameBatch(pairs) {
    listings.clear();
    const done = [], failed = [], undo = [];
    let halted = false;

    // Pre-flight: every source must exist, every target must be free (apart
    // from names that other files of the batch are about to leave).
    const items = [];
    const leaving = new Set(pairs.map(p => loose(p.from)));
    const targets = new Map();
    for (const p of pairs) {
      const st = statOrNull(p.from);
      if (!st) { failed.push({ from: p.from, to: p.to, error: 'the file is no longer there', now: null }); continue; }
      const key = loose(p.to);
      if (targets.has(key)) { failed.push({ from: p.from, to: p.to, error: 'two files would get the same name', now: p.from }); continue; }
      const freedByBatch = leaving.has(key) && key !== loose(p.from);
      if (!freedByBatch && !isFree(p.to, p.from)) {
        failed.push({ from: p.from, to: p.to, error: 'a file with this name already exists', now: p.from });
        continue;
      }
      targets.set(key, true);
      items.push({ from: p.from, to: p.to, stat: st, tmp: null, state: 'planned' });
    }

    // A file only needs a temporary name if its current name is the target
    // of another file of the batch (swaps and chains). Otherwise: direct.
    const wanted = new Set(items.map(i => loose(i.to)));
    const blockers = items.filter(i => wanted.has(loose(i.from)) && loose(i.from) !== loose(i.to));

    journal = { version: 2, startedAt: now(), finished: false,
      ops: items.map(i => ({ from: i.from, to: i.to, tmp: null, state: 'planned' })) };
    saveJournal();
    const jop = i => journal.ops[items.indexOf(i)];

    // Phase 1: step the blockers aside, under a visible name that keeps theirs.
    for (const it of blockers) {
      const tmp = tempNameFor(it.from);
      try {
        if (!tmp) throw new Error('no free temporary name');
        safeRename(it.from, tmp, it.stat);
        it.tmp = tmp; it.state = 'temp';
        Object.assign(jop(it), { tmp, state: 'temp' }); saveJournal();
      } catch (err) {
        it.state = 'failed';
        failed.push({ from: it.from, to: it.to, error: String(err.message || err), now: where(it.from) });
        Object.assign(jop(it), { state: 'failed' }); saveJournal();
        if (err.code === 'EVERIFY') { halted = true; break; }
      }
    }

    // Phase 2: every file to its final name. Stop at the first anomaly.
    for (const it of items) {
      if (halted) break;
      if (it.state === 'failed') continue;
      const src = it.tmp || it.from;
      try {
        safeRename(src, it.to, it.stat);
        it.state = 'done';
        done.push({ from: it.from, to: it.to });
        undo.push({ from: it.to, to: it.from });
        Object.assign(jop(it), { state: 'done' }); saveJournal();
      } catch (err) {
        let nowAt = where(src);
        // A file waiting under its temporary name goes back to its own name,
        // if that name is still free. Never over anything.
        if (it.tmp && nowAt) {
          try { safeRename(it.tmp, it.from, it.stat); nowAt = it.from; }
          catch (e2) { nowAt = where(it.tmp) || where(it.from); }
        }
        it.state = 'failed';
        failed.push({ from: it.from, to: it.to, error: String(err.message || err), now: nowAt });
        Object.assign(jop(it), { state: nowAt === it.tmp ? 'stuck' : 'failed' }); saveJournal();
        if (err.code === 'EVERIFY') halted = true;
      }
    }

    // Files set aside in phase 1 but never reached (halted batch): put them back.
    for (const it of items) {
      if (it.state !== 'temp') continue;
      let nowAt = it.tmp;
      try { safeRename(it.tmp, it.from, it.stat); nowAt = it.from; } catch (e) { nowAt = where(it.tmp) || where(it.from); }
      failed.push({ from: it.from, to: it.to, error: 'batch stopped before this file', now: nowAt });
      Object.assign(jop(it), { state: nowAt === it.tmp ? 'stuck' : 'failed' });
    }
    // Files never reached in phase 2 because the batch halted.
    for (const it of items) {
      if (it.state === 'planned') failed.push({ from: it.from, to: it.to, error: 'batch stopped before this file', now: where(it.from) });
    }

    journal.finished = true;
    journal.finishedAt = now();
    saveJournal();
    return { ok: failed.length === 0, done, failed, undo, halted };
  }

  // ── leftovers from interrupted batches ────────────────────────────────────
  // Lists them straight from the folder, hidden ones included.
  function findLeftovers(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    const out = [];
    for (const n of names) {
      const legacy = n.match(LEGACY_TMP);
      const cur = !legacy && n.match(TMP_RE);
      if (!legacy && !cur) continue;
      const full = path.join(dir, n);
      const st = statOrNull(full);
      if (!st) continue;
      out.push({ name: n, path: full, size: st.size, mtimeMs: st.mtimeMs,
        kind: legacy ? 'legacy' : 'temp',
        original: cur ? cur[1] : null,
        batch: legacy ? legacy[3] : null, index: legacy ? Number(legacy[2]) : null });
    }
    out.sort((a, b) => (a.batch || '').localeCompare(b.batch || '') || (a.index || 0) - (b.index || 0) || a.name.localeCompare(b.name));
    return out;
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

  /*
   * Bring leftovers back into view. Temporary files of the current format
   * return to their original name. Hidden files of the old format lost their
   * name, so they become RECOVERED_<n>.<ext>, in the order of the batch.
   * Only renames, never over anything.
   */
  function recoverLeftovers(dir) {
    listings.clear();
    const restored = [], failed = [];
    for (const f of findLeftovers(dir)) {
      let target;
      if (f.kind === 'temp') target = path.join(dir, f.original);
      else {
        const ext = sniffExt(f.path);
        const base = 'RECOVERED_' + String(f.index + 1).padStart(3, '0');
        target = path.join(dir, base + (ext ? '.' + ext : ''));
        if (!isFree(target, null)) target = path.join(dir, base + '_' + f.batch + (ext ? '.' + ext : ''));
      }
      try { safeRename(f.path, target, statOrNull(f.path)); restored.push({ from: f.path, to: target }); }
      catch (e) { failed.push({ from: f.path, to: target, error: String(e.message || e) }); }
    }
    return { restored, failed };
  }

  function readJournal() {
    if (!journalPath) return null;
    try { return JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch (e) { return null; }
  }

  return { renameBatch, findLeftovers, recoverLeftovers, sniffExt, readJournal, TMP_SUFFIX };
}

module.exports = { createEngine, TMP_SUFFIX, LEGACY_TMP };
