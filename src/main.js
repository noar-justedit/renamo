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
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

// ── Update check — reads renamo's own version.json hosted on GitHub ──
// Never blocks startup, fails silently on any network/TLS issue.
const UPDATE_URL = 'https://raw.githubusercontent.com/noar-justedit/renamo/main/version.json';
function semverGt(a, b){
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++){
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
// GET a URL following up to 3 redirects (https.get does NOT follow them itself).
function fetchFollow(url, hops, cb){
  if (hops > 3) return cb(null);
  try {
    const req = https.get(url, { timeout: 4000 }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location){
        res.resume();
        let next; try { next = new URL(res.headers.location, url).toString(); } catch(e){ return cb(null); }
        return fetchFollow(next, hops + 1, cb);
      }
      if (res.statusCode !== 200){ res.resume(); return cb(null); }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => cb(body));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => cb(null));
  } catch(e){ cb(null); }
}
function checkForUpdate(){
  fetchFollow(UPDATE_URL, 0, (body) => {
    if (!body) return;
    let data; try { data = JSON.parse(body); } catch(e){ return; }
    // Dedicated version.json: { "version": "x.y.z", "url": "..." }.
    // Also accept a nested "renamo" object for backward compatibility.
    const info = (data && data.version) ? data : (data && data.renamo) ? data.renamo : null;
    if (!info || !info.version) return;
    if (semverGt(info.version, app.getVersion()) && win && !win.isDestroyed()){
      win.webContents.send('update-available', { version: info.version, url: info.url || 'https://www.just-edit.fr' });
    }
  });
}

// Parse the output of: Win32_LogicalDisk -> "DeviceID|VolumeName" lines.
// Produces { name, path, type } with a friendly label like "Windows (C:)".
function parseWinDrives(psOutput){
  const out = [];
  String(psOutput).split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t) return;
    const bar = t.indexOf('|');
    const dev = (bar >= 0 ? t.slice(0, bar) : t).trim();
    let label = (bar >= 0 ? t.slice(bar + 1) : '').trim();
    if (!/^[A-Za-z]:$/.test(dev)) return;
    const isNet = /^\\\\/.test(label);        // UNC like \\NAS\media => network drive
    if (isNet) {
      const seg = label.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
      if (seg.length) label = seg[seg.length - 1]; // use the share name
    }
    out.push({ name: label ? (label + ' (' + dev + ')') : dev, path: dev + '\\', type: isNet ? 'network' : 'volume' });
  });
  return out;
}

let win;

function createWindow() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const opts = {
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: '#16161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (isMac) {
    opts.titleBarStyle = 'hiddenInset';
    opts.trafficLightPosition = { x: 14, y: 14 };
  } else {
    // Windows + Linux: frameless, we draw our own window controls in the UI.
    opts.frame = false;
  }
  win = new BrowserWindow(opts);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.once('did-finish-load', () => { setTimeout(checkForUpdate, 1500); });
}

// Custom window controls (used on Windows/Linux frameless windows)
ipcMain.handle('win-min', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
ipcMain.handle('win-max', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) { w.isMaximized() ? w.unmaximize() : w.maximize(); } });
ipcMain.handle('win-close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });

// Update-check support: open the download page in the default browser, expose the app version.
ipcMain.handle('open-external', async (_e, url) => { try { await shell.openExternal(url); } catch(e){} return true; });
ipcMain.handle('get-version', () => app.getVersion());

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------
ipcMain.handle('list-volumes', async () => {
  const out = [];
  if (process.platform === 'win32') {
    let listed = false;
    // Enumerate logical disks WITHOUT probing each drive letter, so empty
    // removable drives (A:, B:, card readers) cannot trigger the blocking
    // "There is no disk in the drive" dialog that freezes the app.
    try {
      const { execSync } = require('child_process');
      const cmd = 'powershell -NoProfile -NonInteractive -Command "'
        + '$v=@{}; Get-CimInstance Win32_LogicalDisk | ForEach-Object { $v[$_.DeviceID]=$_.VolumeName }; '
        + 'Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -match \'^[A-Za-z]:\' } | ForEach-Object { '
        + '$d=$_.Root.Substring(0,2); '
        + '$l = if ($_.DisplayRoot) { $_.DisplayRoot } elseif ($v.ContainsKey($d)) { $v[$d] } else { \'\' }; '
        + '$d + \'|\' + $l }"';
      const res = execSync(cmd, { timeout: 10000, windowsHide: true }).toString();
      const drives = parseWinDrives(res);
      if (drives.length) { drives.forEach(d => out.push(d)); listed = true; }
    } catch (e) { /* fall through to scan */ }
    if (!listed) {
      // Fallback: scan C..Z only (skip A/B floppies to avoid no-disk dialogs)
      for (let c = 67; c <= 90; c++) {
        const root = String.fromCharCode(c) + ':\\';
        try { if (fs.existsSync(root)) out.push({ name: String.fromCharCode(c) + ':', path: root, type: 'volume' }); } catch (e) {}
      }
    }
    try { out.push({ name: 'Home', path: os.homedir(), type: 'home' }); } catch (e) {}
    return out;
  }
  // macOS / Linux
  try {
    out.push({ name: 'Macintosh HD', path: '/', type: 'system' });
  } catch (e) {}
  try {
    const vols = fs.readdirSync('/Volumes', { withFileTypes: true });
    for (const v of vols) {
      if (v.name.startsWith('.')) continue;
      const p = path.join('/Volumes', v.name);
      try {
        const real = fs.realpathSync(p);
        if (real === '/') continue;
      } catch (e) {}
      out.push({ name: v.name, path: p, type: 'volume' });
    }
  } catch (e) {}
  try {
    out.push({ name: 'Home', path: os.homedir(), type: 'home' });
  } catch (e) {}
  return out;
});

// ---------------------------------------------------------------------------
// Read a directory
// ---------------------------------------------------------------------------
ipcMain.handle('read-dir', async (_e, dirPath) => {
  try {
    const dirents = fs.readdirSync(dirPath, { withFileTypes: true });
    const entries = [];
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      const full = path.join(dirPath, d.name);
      let isDir = d.isDirectory();
      let st = null;
      try {
        st = fs.statSync(full);
        if (d.isSymbolicLink()) isDir = st.isDirectory();
      } catch (err) {
        continue;
      }
      const dot = d.name.lastIndexOf('.');
      const ext = (!isDir && dot > 0) ? d.name.slice(dot + 1) : '';
      entries.push({
        name: d.name,
        path: full,
        isDir,
        ext,
        size: st ? st.size : 0,
        birthtimeMs: st ? st.birthtimeMs : 0,
        mtimeMs: st ? st.mtimeMs : 0,
      });
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------------------------------------------------------------------------
// Batch rename, two-phase to avoid in-batch collisions / cycles
// pairs: [{ from, to }] absolute paths in the same directory
// ---------------------------------------------------------------------------
ipcMain.handle('rename-batch', async (_e, pairs) => {
  const done = [];
  const failed = [];
  const undo = [];
  const stage = [];

  // Phase 1: move each source to a unique temp name
  for (let i = 0; i < pairs.length; i++) {
    const { from, to } = pairs[i];
    const dir = path.dirname(from);
    const tmp = path.join(dir, `.renamo_tmp_${process.pid}_${i}_${Date.now()}`);
    try {
      fs.renameSync(from, tmp);
      stage.push({ tmp, to, from });
    } catch (err) {
      failed.push({ from, to, error: String(err.message || err) });
    }
  }

  // Phase 2: move temp to final name
  for (const s of stage) {
    try {
      if (fs.existsSync(s.to)) throw new Error('target already exists');
      fs.renameSync(s.tmp, s.to);
      done.push({ from: s.from, to: s.to });
      undo.push({ from: s.to, to: s.from });
    } catch (err) {
      // roll this one back to its original name
      try { fs.renameSync(s.tmp, s.from); } catch (e2) {}
      failed.push({ from: s.from, to: s.to, error: String(err.message || err) });
    }
  }

  return { ok: failed.length === 0, done, failed, undo };
});

ipcMain.handle('reveal', async (_e, p) => {
  try { shell.showItemInFolder(p); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
});
