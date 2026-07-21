#!/bin/bash
# -----------------------------------------------------------------------------
# renamo - Build Script (macOS Apple Silicon)
# -----------------------------------------------------------------------------
# Usage:
#   chmod +x build.sh
#   ./build.sh              -> macOS Apple Silicon (arm64) .app + .zip
#   ./build.sh --universal  -> macOS Universal (arm64 + x86_64)
#   ./build.sh --dev        -> Dev mode (run without building)
#   ./build.sh --win        -> Windows installer (.exe) + .zip, from macOS (needs Wine for the .exe)
# -----------------------------------------------------------------------------

set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

APP="renamo"
VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")

echo ""
echo "  $APP  v$VERSION"
echo "  -----------------------------"

# Install deps if needed
if [ ! -d "node_modules" ]; then
  echo "  Installing dependencies..."
  npm install
fi

case "$1" in
  --dev)
    echo "  Launching in dev mode..."
    npm start
    ;;
  --universal)
    echo "  Building macOS Universal..."
    npm run build:mac-universal
    echo "  Done. See dist/"
    ;;
  --win)
    echo "  Building Windows installer (x64) from macOS..."
    echo ""
    echo "  NOTE: the NSIS installer (.exe) is built with Wine on macOS."
    echo "        If the build fails, install Wine once:"
    echo "          brew install --cask wine-stable"
    echo "        (The .zip target below does NOT need Wine.)"
    echo ""
    npm run build:win
    echo ""
    echo "  Done."
    echo "  Installer:  dist/renamo-Setup-$VERSION.exe   (NSIS)"
    echo "  Portable:   dist/renamo-$VERSION-win-x64.zip"
    ;;
  *)
    echo "  Building macOS Apple Silicon (arm64)..."
    npm run build:mac
    echo ""
    echo "  Done."
    echo "  Installer:  dist/renamo-$VERSION-mac-arm64.dmg"
    echo "  App:        dist/mac-arm64/$APP.app"
    echo ""
    echo "  Open the .dmg and drag renamo into Applications."
    echo "  First launch (unsigned build): right-click renamo > Open."
    ;;
esac
