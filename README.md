# renamo

Batch rename files and folders with a live preview. Build a new name from independent rules, then see the result before you commit.

macOS and Windows. Built with Electron. No dependencies, no sign-up.

![renamo screenshot](screenshots/renamo.png)

## Features

- Browse your disks, select files or folders, or drop them in from Finder / Explorer
- Independent rules: insert, add, remove, replace, regex, case, extension, date/time, numbering
- REGEX: JavaScript patterns with `$1`, `$2` capture groups, optional case-insensitive matching
- CASE: lowercase, UPPERCASE, Title Case or Sentence case on the name, extension untouched
- CLEAN: strip accents and special characters, replace spaces with underscores
- Sort the list by name, date created, date modified, size or type — numbering follows that order
- Filter the list (Cmd/Ctrl+F); hidden rows are never renamed
- Range selection with shift-click or shift+arrows, select all with Cmd/Ctrl+A
- Live preview with the changed part shown in green and name-collision detection
- Safe renaming: renamo only ever renames. It never deletes, never overwrites and never hides a file,
  renames a file only inside its own folder, checks every rename and stops at the first anomaly,
  with a report of where each file is
- Names that would not work are caught in the preview: an empty name, a name Windows refuses
  (`< > : " | ? *`, a trailing dot or space, `CON`, `NUL`…), a creation date the volume does not record
- Built for big folders on a NAS: only the rows on screen are drawn, the folder is read in parallel,
  and 10 000 files rename in about a second
- One-click undo of the last batch, and recovery of files left behind by an interrupted rename
- Resizable disk browser, full keyboard navigation (every switch, choice and checkbox is reachable with Tab)

### Rule order

Rules always apply in the same order, on the name without its extension:

`INSERT → REMOVE → REPLACE → REGEX → CASE → ADD → DATE/TIME → NUMBERING → CLEAN`,
then the EXTENSION rule on the extension itself. CASE runs before ADD, so a prefix
or suffix you type is kept exactly as typed.

## Build from source

Requires Node.js. From the project root:

Three double-clickable files sit at the root of the project, for building without
opening a terminal:

| Double-click | What it does |
|---|---|
| `Build Mac.command` | signed and notarized macOS DMG |
| `Build Windows.command` | Windows installer and portable zip |
| `Build Mac + Windows.command` | both, for release day |

Each one opens Terminal, runs the build and keeps the window open at the end so the
result stays readable. macOS quarantines files that came out of a downloaded archive,
so the very first time, **right-click the file and choose Open** instead of
double-clicking it. To clear the flag on the whole folder in one go:
`xattr -dr com.apple.quarantine <the renamo folder>`.

They are thin wrappers around `build.sh`, which does everything on macOS — checks,
tests, signing, notarization, stapling and verification:

```
./build.sh                 signed and notarized macOS DMG, ready to ship
./build.sh --all           the same, plus the Windows build
./build.sh --win           Windows only
./build.sh --dev           run the app without building
./build.sh --no-notarize   unsigned macOS build, local testing only
./build.sh --setup         re-enter the Apple credentials
npm test                   rename-engine checks alone, no build
```

Each build only replaces the files of the platform it builds, so a Windows build
keeps the Mac DMG in `dist/` and the other way round. Two builds cannot run at the
same time in the same folder: the second one stops and says so.

`build-win.sh` still exists for a Windows-only build without touching build.sh.
The scripts are committed with the executable bit set; if your copy came from an
archive that dropped it, restore it once with `chmod +x *.sh`.

## Signing and notarization (macOS)

The macOS build is signed with a Developer ID Application certificate and sent to
Apple for notarization, so it opens with a double-click instead of the "unidentified
developer" warning.

You only need the **Developer ID Application** certificate in your login keychain
(`security find-identity -v -p codesigning` should list it). On the first signed
build, `build.sh` reads the team ID off that certificate, asks for your Apple ID and
an [app-specific password](https://support.apple.com/en-us/102654) — not the Apple ID
password — and stores them in the keychain as the `renamo-notarization` profile. It
never asks again. Nothing secret is written into this folder: the script only ever
refers to the profile by name. `NOTARY_PROFILE=<name>` points it at another profile,
`./build.sh --setup` replaces the stored credentials.

Under the hood, `scripts/notarize.js` runs as an electron-builder `afterSign` hook: it
submits the signed `.app`, waits for Apple and staples the ticket into the bundle. The
DMG is then built from that stapled app — and since electron-builder leaves the disk
image itself unsigned, `build.sh` signs it with `codesign --timestamp` (Apple rejects
an unsigned or untimestamped image) before submitting and stapling it in turn. Both
the app and the disk image therefore carry their own signature and ticket, and both
verify offline. Each submission takes a few minutes on Apple's side. If Apple rejects
a build, the script prints the reasons it returned. Notarization needs Node 22.12 or
newer, which is what `@electron/notarize` v3 requires.

The Windows build is not signed: SmartScreen still shows a warning there.

Both installers display the GNU GPL v3 license during installation.

Building the Windows installer from macOS needs Wine; without it the script produces a portable .zip instead of the .exe. See the comments in build-win.sh.

renamo is not sandboxed — it has to reach whatever volume you point it at. On first
access macOS asks for permission to read your Desktop, Documents, Downloads and any
removable or network volume; the reason strings shown in those prompts live in the
`extendInfo` block of package.json.

## Updates

On launch, renamo checks its own version.json in this repository and shows a notice if a newer version exists. Nothing else is sent, nothing is downloaded: the notice only opens the releases page. The check can be turned off in About. If you fork renamo, update the URL in src/main.js (UPDATE_URL) to point to your own version.json, or remove the check.

## Third-party components

- Electron (MIT)
- Tabler Icons (MIT)
- Poppins typeface, used for the wordmark (SIL Open Font License 1.1, see src/fonts/Poppins-OFL.txt)

## License

renamo is free software, licensed under the GNU General Public License v3.0 or later. See the LICENSE file for the full text.

Copyright (C) 2026 just edit
