#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# renamo . Build the Windows version from macOS
# -----------------------------------------------------------------------------
# Place this file inside the "renamo/" folder, then:
#   chmod +x build-win.sh
#   ./build-win.sh            -> NSIS installer (.exe) + portable .zip
#   ./build-win.sh --zip      -> portable .zip only (does NOT need Wine)
#
# The .exe installer is assembled with Wine on macOS. Install it once if needed:
#   brew install --cask wine-stable
# The .zip target needs no Wine and runs directly on Windows once unzipped.
# -----------------------------------------------------------------------------

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")
echo ""
echo "  renamo v$VERSION . Windows build (from macOS)"
echo "  --------------------------------------------"

# Requirements
command -v node >/dev/null 2>&1 || { echo "  Node.js is required. Install it: brew install node"; exit 1; }
if [ ! -d node_modules ]; then
  echo "  Installing dependencies..."
  npm install
fi

MODE="${1:-installer}"

build_zip() {
  echo "  Building portable .zip (x64)..."
  npx electron-builder --win zip --x64
}

build_installer() {
  echo "  Building NSIS installer (.exe) + portable .zip (x64)..."
  npx electron-builder --win nsis zip --x64
}

if [ "$MODE" = "--zip" ]; then
  build_zip
else
  if command -v wine >/dev/null 2>&1 || command -v wine64 >/dev/null 2>&1; then
    build_installer
  else
    echo ""
    echo "  Wine was not found. The NSIS installer (.exe) needs Wine on macOS."
    echo "  Install it once with:  brew install --cask wine-stable"
    echo "  Then re-run:           ./build-win.sh"
    echo ""
    echo "  For now, building the portable .zip instead (no Wine required)..."
    build_zip
  fi
fi

echo ""
echo "  Done. Output in dist/:"
ls -1 dist/*.exe dist/*.zip 2>/dev/null || echo "  (check the dist/ folder)"
echo ""
echo "  On Windows, the unsigned build shows SmartScreen on first launch:"
echo "  click \"More info\" then \"Run anyway\"."
