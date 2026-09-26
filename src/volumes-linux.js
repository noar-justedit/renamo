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
 * The disks shown on Linux. There is no /Volumes: USB drives and cards are
 * mounted under /media/<user> or /run/media/<user>, fixed disks and NAS shares
 * wherever /etc/fstab puts them (often /mnt), and a share opened from the file
 * manager lives under /run/user/<uid>/gvfs. The list comes from the kernel's
 * own table of mounts, /proc/mounts, plus the gvfs folder. Only reading.
 */
'use strict';
const path = require('path');

const NETWORK_FS = new Set(['cifs', 'smb3', 'smbfs', 'nfs', 'nfs4', 'fuse.sshfs', 'fuse.rclone', 'afpfs', 'davfs', 'fuse.davfs2']);
const REMOVABLE_ROOTS = ['/media/', '/run/media/', '/mnt/'];

// /proc/mounts writes a space as \040, a tab as \011, a backslash as \134.
function unescapeMount(s) {
  return String(s).replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

// "smb-share:server=nas.local,share=media" -> "media on nas.local"
function gvfsLabel(name) {
  const kv = {};
  const m = String(name).match(/^([a-z0-9+-]+):(.*)$/i);
  if (!m) return name;
  for (const part of m[2].split(',')) { const i = part.indexOf('='); if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1); }
  const where = kv.server || kv.host || '';
  const what = kv.share || kv.volume || (kv.prefix ? kv.prefix.replace(/^\//, '') : '');
  if (where && what) return what + ' on ' + where;
  return where || name;
}

/*
 * mountsText: the content of /proc/mounts. gvfsNames: the entries of
 * /run/user/<uid>/gvfs. Returns [{ name, path, type }], without the root
 * and the home folder (added by the caller), without duplicates.
 */
function linuxVolumes(mountsText, gvfsDir, gvfsNames) {
  const out = [], seen = new Set();
  for (const line of String(mountsText || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3) continue;
    const mp = unescapeMount(f[1]), fstype = f[2];
    if (mp === '/' || seen.has(mp)) continue;
    const network = NETWORK_FS.has(fstype);
    const removable = REMOVABLE_ROOTS.some(r => mp.startsWith(r));
    if (!network && !removable) continue;
    if (fstype === 'squashfs' || fstype === 'tmpfs' || fstype === 'autofs') continue;
    seen.add(mp);
    out.push({ name: path.basename(mp) || mp, path: mp, type: network ? 'network' : 'volume' });
  }
  for (const n of gvfsNames || []) {
    if (n.startsWith('.')) continue;
    const p = path.join(gvfsDir, n);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ name: gvfsLabel(n), path: p, type: 'network' });
  }
  return out;
}

module.exports = { linuxVolumes, gvfsLabel, unescapeMount };
