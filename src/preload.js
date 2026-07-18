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
const { contextBridge, ipcRenderer } = require('electron');

// IMPORTANT: the preload runs sandboxed, where require('path') is NOT available.
// So path helpers are implemented in plain JS (no require) to keep window.renamo
// from failing to load. They handle both '/' and '\\' separators.
const SEP = process.platform === 'win32' ? '\\' : '/';

function stripTrailing(p){ return p.replace(/[\\/]+$/, ''); }

function join(...parts){
  let res = stripTrailing(parts[0] != null ? String(parts[0]) : '');
  for (let i = 1; i < parts.length; i++){
    const seg = String(parts[i]).replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    if (seg === '') continue;
    res = (res === '' ? '' : res) + SEP + seg;
  }
  return res === '' ? SEP : res;
}

function dirname(p){
  const s = stripTrailing(String(p));
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i < 0) return String(p);          // no separator (e.g. 'C:\\' after strip -> 'C:')
  if (i === 0) return SEP;              // '/x' -> '/'
  const head = s.slice(0, i);
  if (/^[A-Za-z]:$/.test(head)) return head + SEP; // 'C:\\X' -> 'C:\\'
  return head;
}

function basename(p){
  const parts = stripTrailing(String(p)).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

contextBridge.exposeInMainWorld('renamo', {
  platform: process.platform,
  sep: SEP,
  join,
  dirname,
  basename,
  listVolumes: () => ipcRenderer.invoke('list-volumes'),
  readDir: (p) => ipcRenderer.invoke('read-dir', p),
  renameBatch: (pairs) => ipcRenderer.invoke('rename-batch', pairs),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  winMin: () => ipcRenderer.invoke('win-min'),
  winMax: () => ipcRenderer.invoke('win-max'),
  winClose: () => ipcRenderer.invoke('win-close'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onUpdateAvailable: (cb) => { ipcRenderer.on('update-available', (_e, d) => cb(d)); },
});
