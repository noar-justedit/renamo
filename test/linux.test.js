/*
 * renamo - Linux checks: the disk list, and the packaging settings.
 *
 *   node test/linux.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { linuxVolumes, gvfsLabel } = require('../src/volumes-linux');

let passed = 0;
function t(label, fn) {
  try { fn(); passed++; }
  catch (err) { console.error('FAIL  ' + label + '\n      ' + err.message); process.exitCode = 1; }
}

const MOUNTS = [
  '/dev/nvme0n1p2 / ext4 rw,relatime 0 0',
  'proc /proc proc rw 0 0',
  'tmpfs /run tmpfs rw 0 0',
  '/dev/loop3 /snap/core22/1380 squashfs ro 0 0',
  '/dev/sdb1 /media/noar/CARD\\040A001 exfat rw 0 0',
  '/dev/sdc1 /run/media/noar/RUSHES vfat rw 0 0',
  '//nas.local/media /mnt/nas cifs rw 0 0',
  'nas:/export/prod /srv/prod nfs4 rw 0 0',
  '/dev/sda1 /boot/efi vfat rw 0 0',
  'gvfsd-fuse /run/user/1000/gvfs fuse.gvfsd-fuse rw 0 0',
].join('\n');

t('cards, USB drives and NAS shares are listed; system mounts are not', () => {
  const v = linuxVolumes(MOUNTS, '/run/user/1000/gvfs', ['smb-share:server=nas.local,share=media']);
  const byPath = Object.fromEntries(v.map(x => [x.path, x]));
  assert.deepStrictEqual(Object.keys(byPath).sort(), [
    '/media/noar/CARD A001', '/mnt/nas', '/run/media/noar/RUSHES',
    '/run/user/1000/gvfs/smb-share:server=nas.local,share=media', '/srv/prod',
  ].sort());
  assert.strictEqual(byPath['/media/noar/CARD A001'].name, 'CARD A001', 'the \\040 space was not decoded');
  assert.strictEqual(byPath['/mnt/nas'].type, 'network');
  assert.strictEqual(byPath['/srv/prod'].type, 'network');
  assert.strictEqual(byPath['/media/noar/CARD A001'].type, 'volume');
});

t('a share opened from the file manager gets a readable name', () => {
  assert.strictEqual(gvfsLabel('smb-share:server=nas.local,share=media'), 'media on nas.local');
  assert.strictEqual(gvfsLabel('sftp:host=192.168.1.20'), '192.168.1.20');
});

t('nothing to read, nothing listed (and no crash)', () => {
  assert.deepStrictEqual(linuxVolumes('', '/run/user/1000/gvfs', []), []);
  assert.deepStrictEqual(linuxVolumes(undefined, '/x', undefined), []);
});

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
t('the Linux build makes an AppImage and a .deb, with the renamo icon', () => {
  const L = pkg.build.linux;
  assert.deepStrictEqual(L.target.map(x => x.target).sort(), ['AppImage', 'deb']);
  for (const s of [16, 32, 48, 64, 128, 256, 512]) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', L.icon, s + 'x' + s + '.png')), s + 'px icon missing');
  }
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'icon.png')), 'window icon missing');
  assert.ok(/@/.test(L.maintainer), 'a .deb needs a maintainer e-mail');
});

t('the macOS-only package cannot stop an install on Linux or Windows', () => {
  assert.ok(!(pkg.devDependencies || {})['dmg-license'], 'dmg-license is a hard dependency: npm refuses it on Linux');
  assert.ok((pkg.optionalDependencies || {})['dmg-license']);
});

t('build-linux.sh is executable and refuses to run anywhere but Linux', () => {
  const f = path.join(__dirname, '..', 'build-linux.sh');
  assert.ok(fs.statSync(f).mode & 0o111, 'not executable');
  const s = fs.readFileSync(f, 'utf8');
  assert.ok(/uname -s\)" = "Linux"/.test(s));
  assert.ok(/dpkg-deb -f "\$DEB" Version/.test(s), 'the .deb is not checked');
});

console.log(passed + ' Linux checks passed' + (process.exitCode ? ' — with failures above' : ''));
