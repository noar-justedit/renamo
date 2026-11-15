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
 * Video information for the name template: resolution, frame rate, codec,
 * recording date. Read by MediaInfo (mediainfo.js, MediaInfoLib compiled to
 * WebAssembly, BSD-2-Clause): no program to install, nothing to sign apart.
 *
 * Read only: each file is opened with the 'r' flag and only the parts
 * MediaInfo asks for are read (headers and indexes, not the whole clip).
 * Files are read one after the other with one MediaInfo instance, and each
 * answer is kept in memory as long as the file's size and date do not
 * change, renamed or not, so a preview rebuilt a hundred times, or rebuilt
 * after a rename, reads each clip once.
 */
'use strict';
const nodeFs = require('fs');

const CHUNK = 256 * 1024;
const READ_TIMEOUT_MS = 20000;   // a clip not read in 20 s (share gone) is given up
let factory = null;              // the MediaInfo instance, created on first use
let queue = Promise.resolve();   // one file at a time
let generation = 0;              // raised by cancelMediaReads()
let analyzed = 0;                // clips actually read (for the tests)
const cache = new Map();         // file identity -> answer

// A failed start (WebAssembly not loaded) is not kept: the next file tries again.
function getMediaInfo() {
  if (!factory) {
    factory = require('mediainfo.js').mediaInfoFactory({ format: 'object', chunkSize: CHUNK })
      .catch(err => { factory = null; throw err; });
  }
  return factory;
}

const num = v => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : null; };

/*
 * A date as MediaInfo writes it, as a timestamp - or null.
 * The date and time are kept AS WRITTEN in the clip: a "UTC" label or an
 * offset ("+04:00") is not converted to the time zone of the computer, so two
 * editors in two countries get the same name for the same clip.
 *   "2026-11-13 09:12:33 UTC", "UTC 2026-11-13 09:12:33",
 *   "2026-11-13T09:12:33.000+04:00", "2026-11-13"
 */
function parseMediaDate(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, Y, Mo, D, h = '0', mi = '0', se = '0'] = m;
  if (+Y < 1971) return null;                     // "1904-01-01": a camera clock never set
  return new Date(+Y, +Mo - 1, +D, +h, +mi, +se).getTime();
}

/*
 * What the template uses, from MediaInfo's answer.
 * shotMs: the recording date (Recorded_Date), else the date the file was
 * written by the device that made it (Encoded_Date: for a camera original, the
 * recording; for an export, the export). Tagged_Date (last edit of the tags)
 * is never used.
 */
function summarize(result) {
  const tracks = (result && result.media && result.media.track) || [];
  const general = tracks.find(t => t['@type'] === 'General') || {};
  const picture = tracks.find(t => t['@type'] === 'Video') || tracks.find(t => t['@type'] === 'Image') || null;
  return {
    width: picture ? num(picture.Width) : null,
    height: picture ? num(picture.Height) : null,
    fps: picture ? num(picture.FrameRate) : null,
    codec: picture && picture.Format ? String(picture.Format) : null,
    shotMs: parseMediaDate(general.Recorded_Date) || parseMediaDate(general.Encoded_Date),
  };
}

async function analyze(p, fs) {
  const mi = await getMediaInfo();
  const fh = await fs.promises.open(p, 'r');
  try {
    const { size } = await fh.stat();
    const result = await mi.analyzeData(size, async (len, offset) => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, offset);
      return buf.subarray(0, bytesRead);
    });
    analyzed++;
    return summarize(result);
  } finally {
    await fh.close().catch(() => {});
  }
}

// Gives up after READ_TIMEOUT_MS. The instance that was reading may still be
// stuck on the share: it is dropped, and the next file starts a fresh one.
function analyzeWithTimeout(p, fs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { factory = null; reject(new Error('timed out')); }, READ_TIMEOUT_MS);
  });
  return Promise.race([analyze(p, fs), timeout]).finally(() => clearTimeout(timer));
}

/*
 * The cache key is the file itself (volume + file number), not its name: a
 * renamed clip is not read again. Volumes without file numbers fall back to
 * the path. Size and date are part of the key, so a changed file is read again.
 */
function identity(p, st) {
  const id = st.ino ? `${st.dev}:${st.ino}` : `path:${p}`;
  return `${id}:${st.size}:${st.mtimeMs}`;
}

// -> { path, info } | { path, error } | { path, cancelled: true }
function readMediaInfo(p, fs = nodeFs) {
  const gen = generation;
  const job = queue.then(async () => {
    if (gen !== generation) return { path: p, cancelled: true };
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile()) return { path: p, error: 'not a file' };
      const key = identity(p, st);
      const hit = cache.get(key);
      if (hit) return { path: p, info: hit };
      const info = await analyzeWithTimeout(p, fs);
      cache.set(key, info);
      return { path: p, info };
    } catch (err) {
      return { path: p, error: String((err && err.message) || err) };
    }
  });
  queue = job.catch(() => {});
  return job;
}

// Files asked for and not started yet are dropped (another folder was opened).
function cancelMediaReads() { generation++; }

module.exports = { readMediaInfo, cancelMediaReads, summarize, parseMediaDate, clipsAnalyzed: () => analyzed };
