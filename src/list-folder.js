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
 * Reading a folder for the list. Read only: readdir and stat, nothing else.
 *
 * Two modes:
 *   - one folder: its files and subfolders, as always;
 *   - with subfolders: the FILES of the folder and of every folder below it,
 *     each with the folder it sits in. Folders themselves are not listed in
 *     this mode: renaming a folder and the files inside it in the same batch
 *     would change the files' paths halfway through.
 *
 * Hidden names (starting with a dot) are skipped, folders are never followed
 * through a link (no loop), and the walk stops at MAX_FILES files or
 * MAX_DEPTH levels, saying so, so that pointing it at a whole disk cannot
 * freeze the window.
 */
'use strict';
const path = require('path');
const nodeFs = require('fs');

const MAX_FILES = 20000;
const MAX_DEPTH = 12;
const STATS_IN_FLIGHT = 48;
const FOLDERS_IN_FLIGHT = 8;

// One collator for every comparison: building the options for each pair is slow.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Run `fn` over `list` with at most `limit` calls in flight. On a network share
// each stat is a round trip: 48 at a time instead of one after the other.
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => { while (next < list.length) { const k = next++; out[k] = await fn(list[k], k); } };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

function entryFrom(dir, root, name, st) {
  const isDir = st.isDirectory();
  const dot = name.lastIndexOf('.');
  return {
    name,
    path: path.join(dir, name),
    dir,
    // Folder of the file relative to the folder opened ('' for that folder).
    rel: path.relative(root, dir),
    isDir,
    ext: (!isDir && dot > 0) ? name.slice(dot + 1) : '',
    size: st.size,
    // 0 when the volume does not record a creation date (most NAS shares,
    // Linux): the window then says so instead of silently using today.
    birthtimeMs: st.birthtimeMs > 0 ? st.birthtimeMs : 0,
    mtimeMs: st.mtimeMs,
  };
}

/*
 * listFolder(root, { dirsOnly, recursive }) ->
 *   { entries, others, listings, truncated }
 *   entries   rows for the list
 *   others    names that are in the folders read but not in `entries`
 *             (subfolders, in the "with subfolders" mode), as { dir, name }:
 *             a new name must not take one of them
 *   listings  { dir, names } for every folder read, hidden names included
 *             (where an interrupted rename may have left files)
 *   truncated true when MAX_FILES or MAX_DEPTH stopped the walk
 */
async function listFolder(root, opts = {}, fs = nodeFs) {
  const dirsOnly = !!opts.dirsOnly;
  const recursive = !!opts.recursive && !dirsOnly;
  const entries = [], others = [], listings = [];
  let truncated = false;

  // One folder: its listing, its rows, and the subfolders to read next.
  async function readOne({ dir, depth }) {
    let dirents;
    try { dirents = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch (err) { if (dir === root) throw err; return null; }   // an unreadable subfolder is skipped
    const out = { listing: { dir, names: dirents.map(d => d.name) }, rows: [], others: [], next: [] };
    let visible = dirents.filter(d => !d.name.startsWith('.'));
    if (dirsOnly) visible = visible.filter(d => !d.isFile());
    if (recursive) {
      for (const d of visible) {
        if (!d.isDirectory()) continue;
        out.others.push({ dir, name: d.name });
        if (depth + 1 > MAX_DEPTH) truncated = true;
        else out.next.push({ dir: path.join(dir, d.name), depth: depth + 1 });
      }
      visible = visible.filter(d => !d.isDirectory());
    }
    const rows = await mapLimit(visible, STATS_IN_FLIGHT, async (d) => {
      if (dirsOnly && d.isDirectory()) {
        return { name: d.name, path: path.join(dir, d.name), dir, rel: '', isDir: true, ext: '', size: 0, birthtimeMs: 0, mtimeMs: 0 };
      }
      let st;
      try { st = await fs.promises.stat(path.join(dir, d.name)); } catch (err) { return null; }
      if (dirsOnly && !st.isDirectory()) return null;
      // A link to a folder, met in the walk: listed by name only, never entered.
      if (recursive && st.isDirectory()) { out.others.push({ dir, name: d.name }); return null; }
      return entryFrom(dir, root, d.name, st);
    });
    out.rows = rows.filter(Boolean);
    return out;
  }

  // Level by level, several folders of a level read at once: on a NAS each
  // folder is a round trip, and camera cards hold many small folders.
  let level = [{ dir: root, depth: 0 }];
  while (level.length) {
    const results = await mapLimit(level, FOLDERS_IN_FLIGHT, readOne);
    const next = [];
    for (const r of results) {
      if (!r) continue;
      listings.push(r.listing);
      others.push(...r.others);
      next.push(...r.next);
      for (const row of r.rows) {
        if (entries.length >= MAX_FILES) { truncated = true; break; }
        entries.push(row);
      }
    }
    level = recursive && !truncated ? next : [];
  }

  // The disk tree shows folders in name order. The file list is sorted by the
  // window, with the order the user picked.
  if (dirsOnly) entries.sort((a, b) => collator.compare(a.name, b.name));
  return { entries, others, listings, truncated };
}

module.exports = { listFolder, mapLimit, MAX_FILES, MAX_DEPTH };
