# Changelog

All notable changes to renamo. Versions before 1.6.0 were not recorded here.

## 1.9.0

- **TEMPLATE rule**: write the whole name with tags in braces, in any order:
  `{name}`, `{original}`, `{folder1}`, `{folder2}`…, `{created:…}`, `{modified:…}`,
  `{today:…}`, `{shot:…}`, `{resolution}`, `{width}`, `{height}`, `{fps}`, `{codec}`,
  `{n:3}`. Date formats `YYYY YY MM DD HH mm ss`. Buttons insert a tag at the cursor.
- **Subfolders**: lists the files of every folder below the one opened, with their
  folder shown before the name, and renames them in one batch, each in its own
  folder. Name collisions are checked folder by folder. Up to 20 000 files.
- **Video information** (resolution, frame rate, codec, recording date), read with
  MediaInfo (mediainfo.js), read only, in the background; Rename waits until every
  name is known. A file with no such information is flagged, never guessed.
  `{shot}` keeps the date and time as written in the clip (Recorded_Date, else
  Encoded_Date), without converting time zones. Reads stop when another folder is
  opened, give up after 20 s on a share that stops answering, and a renamed clip is
  not read again.
- With Subfolders, `{n}` and NUMBERING start again at 1 in each folder.
- **Template presets**: save the template under a name, pick it from a list, remove
  it, and share it as one line of text (`renamo-preset {…}`) that another renamo
  pastes in. Presets are kept in renamo on the computer, never in your folders.
- Rename and Undo stay off while a batch is running.
- New names may not hold invisible or right-to-left characters (they can make a
  name look like another extension).
- **The rules are kept for the next launch**, as you left them (Subfolders is not
  kept: opening a whole disk with it at launch could take long).
- Date formats also accept `YY` and `HH`.
- **Electron 45** (was 42). **macOS 13 (Ventura) or later is now required**: Electron
  44 and later no longer run on macOS 12. The declared minimum was still macOS 11 although
  Electron 42 already needed macOS 12.
- The repository no longer carries the maintainer's working files (AI rules,
  project state, internal notes, release notes, publishing script).

## 1.8.1

- **Keyboard: the path bar.** Every parent folder in the path at the top is now a
  button the Tab key reaches; Enter or Space opens it. A folder reached this way
  scrolls into view when the path is too long.
- **Cmd+Up (macOS) / Ctrl+Up (Windows, Linux)** opens the parent folder, as in Finder
  and Explorer. It does nothing while you type in a field.
- macOS: the app no longer accepts code libraries signed by anyone else
  (`disable-library-validation` entitlement removed).
- Build launchers renamed `scripts/build_mac.command`, `scripts/build_windows.command`
  and `scripts/build_mac_windows.command`.
- `scripts/push_github.command`: sends the project folder to GitHub, removed files
  included; refuses to send anything without a new version number; `version.json`
  only once the Release is published.
- Project tracking files added: `AGENTS.md`, `ETAT_PROJET.md`, `CHANGELOG.md`.

## 1.8.0

- Right-click on a name: **Use selection as search** (part of a name becomes the
  Replace search) and **Edit name…** (rename one item through the same engine, with
  Undo). Names are selectable.
- Builds run in a temporary folder on the Mac and are copied to `dist/` only after
  success (the project lives on a NAS).
- Build scripts and launchers moved to `scripts/`; `release.sh` removed.

## 1.7.0

- Linux: AppImage and `.deb` packages, `build-linux.sh`, Linux drives listed in the
  sidebar.

## 1.6.4

- Full review fixed: possible overwrite on a case-only rename (case-sensitive
  volume), emptied name turning into a hidden file, false "file lost" report,
  collision hidden by the filter.
- Speed: 10,000 files went from 42 s to under 1 s; virtual list.
- Full keyboard access; charter fixes; hardening.
- Case tests made independent of the disk (the Mac build failed on them).

## 1.6.3

- New rename engine after the hidden-files incident on the NAS: no hidden temporary
  names, journal, recovery of leftovers.
- Build fixes: NSIS cache, Mac and Windows builds erasing each other, build lock.

## 1.6.2

- Noar UI charter, green Sapin icon `#3f9a6f`, SVG icon.

## 1.6.1

- Developer ID signing and notarization, all-in-one `build.sh`, signed DMG,
  double-click `.command` launchers.

## 1.6.0

- REGEX and CASE rules, sorting, filter, Shift+click, drag and drop.
