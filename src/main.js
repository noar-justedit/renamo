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
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

// Folder listings are sorted once with one collator (creating the comparison
// options for every pair made a 10 000-file sort 15 times slower).
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

const isStr = v => typeof v === 'string' && v.length > 0;

// ── Update check — reads renamo's own version.json hosted on GitHub ──
// Asked for by the window (which can turn it off), never blocks, fails
// silently. The answer only ever leads to a web page: nothing is downloaded.
const UPDATE_URL = 'https://raw.githubusercontent.com/noar-justedit/renamo/main/version.json';
const FALLBACK_URL = 'https://github.com/noar-justedit/renamo/releases';
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
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
function isHttpsUrl(u) {
  try { return new URL(String(u)).protocol === 'https:'; } catch (e) { return false; }
}
// GET a URL following up to 3 redirects (https.get does NOT follow them itself).
function fetchFollow(url, hops, cb){
  if (hops > 3 || !isHttpsUrl(url)) return cb(null);
  try {
    const req = https.get(url, { timeout: 4000 }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location){
        res.resume();
        let next; try { next = new URL(res.headers.location, url).toString(); } catch(e){ return cb(null); }
        return fetchFollow(next, hops + 1, cb);
      }
      if (res.statusCode !== 200){ res.resume(); return cb(null); }
      let body = '';
      res.on('data', c => { body += c; if (body.length > 64 * 1024) req.destroy(); });
      res.on('end', () => cb(body));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => cb(null));
  } catch(e){ cb(null); }
}
function checkForUpdate(){
  return new Promise(resolve => {
    fetchFollow(UPDATE_URL, 0, (body) => {
      if (!body) return resolve(null);
      let data; try { data = JSON.parse(body); } catch(e){ return resolve(null); }
      // Dedicated version.json: { "version": "x.y.z", "url": "..." }.
      // Also accept a nested "renamo" object for backward compatibility.
      const info = (data && data.version) ? data : (data && data.renamo) ? data.renamo : null;
      if (!info || !VERSION_RE.test(String(info.version))) return resolve(null);
      if (!semverGt(info.version, app.getVersion())) return resolve(null);
      resolve({ version: String(info.version), url: isHttpsUrl(info.url) ? String(info.url) : FALLBACK_URL });
    });
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

// The application menu. No developer tools and no reload in the shipped app:
// they would give direct access to the rename commands, and a reload drops the
// current batch. macOS keeps its Edit menu, which copy and paste rely on.
function buildMenu() {
  const dev = app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }];
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }, ...dev] },
      { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(dev.length ? Menu.buildFromTemplate([{ label: 'Dev', submenu: dev.slice(1) }]) : null);
  }
}

let win;

function createWindow() {
  const isMac = process.platform === 'darwin';
  const opts = {
    width: 1180,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#0a0b0e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
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
  // The window only ever shows renamo's own page: no pop-up, no navigation.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-redirect', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
}

// Custom window controls (used on Windows/Linux frameless windows)
ipcMain.handle('win-min', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
ipcMain.handle('win-max', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) { w.isMaximized() ? w.unmaximize() : w.maximize(); } });
ipcMain.handle('win-close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });

// Open a web page in the default browser. https only: this handler must never
// become a way to launch a file or another application.
ipcMain.handle('open-external', async (_e, url) => {
  if (!isHttpsUrl(url)) return false;
  try { await shell.openExternal(String(url)); } catch(e){ return false; }
  return true;
});
ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('check-update', () => checkForUpdate());

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// A defence in depth: whatever window is created, it gets the same guards.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e) => e.preventDefault());
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
// Read a directory. Asynchronous, with the stats run 48 at a time: on a NAS a
// folder of 10 000 files no longer freezes the window for seconds. With
// { dirsOnly: true } (the disk tree) files are not even looked at.
// ---------------------------------------------------------------------------
ipcMain.handle('read-dir', async (_e, dirPath, opts) => {
  if (!isStr(dirPath)) return { ok: false, error: 'invalid path' };
  const dirsOnly = !!(opts && opts.dirsOnly);
  try {
    const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
    let visible = dirents.filter(d => !d.name.startsWith('.'));
    if (dirsOnly) visible = visible.filter(d => !d.isFile());
    const rows = await mapLimit(visible, 48, async (d) => {
      const full = path.join(dirPath, d.name);
      if (dirsOnly && d.isDirectory()) return { name: d.name, path: full, isDir: true, ext: '', size: 0, birthtimeMs: 0, mtimeMs: 0 };
      let st;
      try { st = await fs.promises.stat(full); } catch (err) { return null; }
      const isDir = st.isDirectory();
      if (dirsOnly && !isDir) return null;
      const dot = d.name.lastIndexOf('.');
      return {
        name: d.name,
        path: full,
        isDir,
        ext: (!isDir && dot > 0) ? d.name.slice(dot + 1) : '',
        size: st.size,
        // 0 when the volume does not record a creation date (most NAS shares,
        // Linux): the window then says so instead of silently using today.
        birthtimeMs: st.birthtimeMs > 0 ? st.birthtimeMs : 0,
        mtimeMs: st.mtimeMs,
      };
    });
    const entries = rows.filter(Boolean);
    entries.sort((a, b) => (a.isDir !== b.isDir) ? (a.isDir ? -1 : 1) : collator.compare(a.name, b.name));
    // Leftovers of an interrupted rename, found in the same listing (hidden
    // names included) instead of reading the folder a second time.
    const leftovers = dirsOnly ? [] : getEngine().leftoversFrom(dirPath, dirents.map(d => d.name));
    return { ok: true, entries, leftovers };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------------------------------------------------------------------------
// Batch rename. All file operations live in rename-engine.js, which only ever
// renames: it never deletes, never overwrites, never hides a file, renames a
// file only inside its own folder, checks each rename and stops at the first
// anomaly. Its journal sits in the app's own data folder, never next to the
// user's files.
// ---------------------------------------------------------------------------
const { createEngine } = require('./rename-engine');
let engine = null;
function getEngine() {
  if (!engine) engine = createEngine({ journalPath: path.join(app.getPath('userData'), 'rename-journal.json') });
  return engine;
}

// Whatever goes wrong, the window gets an answer it can show: never a silent
// rejected promise that leaves the Rename button dead.
ipcMain.handle('rename-batch', async (_e, pairs) => {
  const list = Array.isArray(pairs) ? pairs.filter(p => p && typeof p === 'object').map(p => ({ from: p.from, to: p.to })) : [];
  try { return getEngine().renameBatch(list); }
  catch (err) { return { ok: false, error: String(err.message || err), done: [], failed: [], undo: [], halted: true }; }
});

// Files left behind by an interrupted rename (hidden ones included).
ipcMain.handle('scan-leftovers', async (_e, dir) => {
  if (!isStr(dir)) return [];
  try { return getEngine().findLeftovers(dir); } catch (e) { return []; }
});
ipcMain.handle('recover-leftovers', async (_e, dir) => {
  if (!isStr(dir)) return { restored: [], failed: [], error: 'invalid path' };
  try { return getEngine().recoverLeftovers(dir); }
  catch (err) { return { restored: [], failed: [], error: String(err.message || err) }; }
});

// A batch that never reached its end (crash, power cut, forced quit).
ipcMain.handle('unfinished-batch', async () => {
  const j = getEngine().readJournal();
  if (!j || j.finished) return null;
  const pending = (j.ops || []).filter(o => o.state !== 'done');
  const dirs = [...new Set(pending.map(o => path.dirname(o.from)))];
  return { startedAt: j.startedAt, dirs, count: pending.length };
});

// ---------------------------------------------------------------------------
// Stat a list of paths (used by drag & drop to tell folders from files)
// ---------------------------------------------------------------------------
ipcMain.handle('stat-paths', async (_e, paths) => {
  const list = Array.isArray(paths) ? paths.filter(isStr) : [];
  return mapLimit(list, 32, async (p) => {
    try {
      const st = await fs.promises.stat(p);
      return { path: p, exists: true, isDir: st.isDirectory() };
    } catch (err) {
      return { path: p, exists: false, isDir: false };
    }
  });
});

ipcMain.handle('reveal', async (_e, p) => {
  if (!isStr(p)) return { ok: false, error: 'invalid path' };
  try { shell.showItemInFolder(p); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
});
