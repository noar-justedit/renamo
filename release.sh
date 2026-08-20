#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# renamo - one-shot release build from macOS: tests + macOS DMG + Windows
# -----------------------------------------------------------------------------
#   chmod +x release.sh          (only needed once, if git lost the flag)
#   ./release.sh                 -> tests, macOS arm64 DMG, Windows (.exe if Wine, else .zip)
#   ./release.sh --mac           -> tests + macOS only
#   ./release.sh --win           -> tests + Windows only
#   ./release.sh --skip-tests    -> can be combined with the above
#
# Nothing here signs or notarizes the app: first launch on another Mac needs
# right-click > Open, and Windows shows SmartScreen ("More info" > "Run anyway").
# -----------------------------------------------------------------------------
set -euo pipefail
# Resolve the script before moving: $0 may be relative to the caller's directory.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
cd "$(dirname "$SELF")"

VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")
DO_MAC=1; DO_WIN=1; DO_TESTS=1

# ${1+"$@"} instead of "$@": macOS still ships bash 3.2, where an empty "$@"
# trips `set -u`.
for arg in ${1+"$@"}; do
  case "$arg" in
    --mac)        DO_WIN=0 ;;
    --win)        DO_MAC=0 ;;
    --skip-tests) DO_TESTS=0 ;;
    -h|--help)    sed -n "2,13p" "$SELF"; exit 0 ;;
    *) echo "  Unknown option: $arg"; exit 1 ;;
  esac
done

echo ""
echo "  renamo v$VERSION - release build"
echo "  ---------------------------------"

command -v node >/dev/null 2>&1 || { echo "  Node.js is required: brew install node"; exit 1; }
if [ ! -d node_modules ]; then
  echo "  Installing dependencies..."
  npm install
fi

if [ "$DO_TESTS" = "1" ]; then
  echo "  Running the rename-engine tests..."
  npm test
  echo ""
fi

# Start from a clean dist/ so the listing at the end only shows this build.
rm -rf dist

if [ "$DO_MAC" = "1" ]; then
  echo "  Building macOS (arm64)..."
  npm run build:mac
  echo ""
fi

if [ "$DO_WIN" = "1" ]; then
  if command -v wine >/dev/null 2>&1 || command -v wine64 >/dev/null 2>&1; then
    echo "  Building Windows installer (.exe) + portable .zip..."
    npx electron-builder --win nsis zip --x64
  else
    echo "  Wine not found - the NSIS .exe cannot be assembled on this Mac."
    echo "  Install it once with:  brew install --cask wine-stable"
    echo "  Building the portable .zip instead (no Wine needed)..."
    npx electron-builder --win zip --x64
  fi
  echo ""
fi

echo "  Done. Output in dist/:"
ls -1 dist/*.dmg dist/*.exe dist/*.zip 2>/dev/null || echo "  (check the dist/ folder)"
echo ""
