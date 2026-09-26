#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# renamo . Build the Linux packages. Run this ON a Linux machine (x64).
# -----------------------------------------------------------------------------
#   bash build-linux.sh
#
# Output, in dist/:
#   renamo-<version>-x86_64.AppImage   runs on any distribution, no install
#   renamo_<version>_amd64.deb         Debian, Ubuntu, Pop!_OS, Mint...
#
# Building the Linux packages from macOS is not supported: electron-builder
# produces a .deb there that does not install. Same rule as ingesto.
# The packages are not signed (decision of 31/08/2026, as for Windows).
# -----------------------------------------------------------------------------

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

step() { printf '\n  %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\n  STOP: %s\n\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "this script builds on Linux only. On a Mac, use Build Mac.command or Build Windows.command."
[ "$(uname -m)" = "x86_64" ] || die "the packages are built for x64 (this machine is $(uname -m))."

# ── Node ──────────────────────────────────────────────────────────────────────
# electron-builder 26 needs Node 20.19 or newer. The version from
# 'apt install nodejs' is older on most distributions.
node_ok() {
  command -v node >/dev/null 2>&1 && \
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=19)?0:1)'
}
# A freshly installed nvm is not loaded until the terminal restarts: load it.
if ! node_ok && [ -s "$HOME/.nvm/nvm.sh" ]; then
  info "The system Node is too old - loading nvm..."
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" || true
  nvm use --silent 22 >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || true
fi
if ! node_ok; then
  printf '\n  Node.js %s - this build needs Node 20.19 or newer (22 LTS recommended).\n' "$(node -v 2>/dev/null || echo 'is missing')"
  cat <<'EOF'

  Option A - nvm (no sudo, recommended). Paste these three lines:
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    . "$HOME/.nvm/nvm.sh"
    nvm install 22

  Option B - NodeSource (system-wide):
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt install -y nodejs

  Then run this script again.

EOF
  exit 1
fi

VERSION=$(node -e "console.log(require('./package.json').version)")
printf '\n  renamo  v%s  .  Linux build\n  -----------------------------\n' "$VERSION"
info "Node.js $(node -v)"

# ── Tools the .deb needs ──────────────────────────────────────────────────────
MISSING=""
for TOOL in dpkg-deb fakeroot; do
  command -v "$TOOL" >/dev/null 2>&1 || MISSING="$MISSING $TOOL"
done
[ -z "$MISSING" ] || die "missing build tools:$MISSING. Install them with:  sudo apt install dpkg fakeroot"

# ── One build at a time in this folder ────────────────────────────────────────
LOCK=".build.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  OTHER=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$OTHER" ] && kill -0 "$OTHER" 2>/dev/null; then
    die "another build is already running in this folder (process $OTHER). Wait for it to finish."
  fi
  info "A previous build was interrupted; taking over its lock."
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

# ── Dependencies and tests ────────────────────────────────────────────────────
step "Installing dependencies..."
npm install --no-audit --no-fund

step "Running the rename-engine tests..."
npm test

# ── Build ─────────────────────────────────────────────────────────────────────
# Only the Linux output is cleared: a Mac or Windows build sitting in dist/
# is kept.
mkdir -p dist
rm -rf dist/*.AppImage dist/*.deb dist/linux-unpacked dist/latest-linux.yml

step "Building AppImage + deb (x64)..."
npx electron-builder --linux AppImage deb --x64

APPIMAGE="dist/renamo-$VERSION-x86_64.AppImage"
DEB="dist/renamo_${VERSION}_amd64.deb"
[ -f "$APPIMAGE" ] || die "no AppImage was produced - read the messages above."
[ -f "$DEB" ] || die "no .deb was produced - read the messages above."

# ── Checks: nothing is announced without proof ───────────────────────────────
step "Checking the packages..."
[ -x dist/linux-unpacked/renamo ] || die "the packaged app has no 'renamo' program in dist/linux-unpacked."
PKG=$(dpkg-deb -f "$DEB" Package)
PKGV=$(dpkg-deb -f "$DEB" Version)
[ "$PKG" = "renamo" ] || die "the .deb is named '$PKG', expected 'renamo'."
[ "$PKGV" = "$VERSION" ] || die "the .deb carries version $PKGV, expected $VERSION."
# The listing is read whole into a variable: piping it into 'grep -q' stops
# the reading half-way, which this script's strict mode takes for an error.
LISTING=$(dpkg-deb -c "$DEB")
case "$LISTING" in *usr/share/applications/renamo.desktop*) ;; *) die "the .deb has no menu entry (renamo.desktop)." ;; esac
case "$LISTING" in *usr/share/icons/hicolor/256x256/apps/renamo.png*) ;; *) die "the .deb has no icon." ;; esac
info "deb      : $PKG $PKGV, menu entry and icon present"
chmod +x "$APPIMAGE"
info "AppImage : executable"

printf '\n  Done. Packages in dist/:\n'
ls -1 "$APPIMAGE" "$DEB" | sed 's/^/    /'
cat <<EOF

  Install the deb:   sudo apt install ./$DEB
  Run the AppImage:  ./$APPIMAGE

  AppImages need FUSE 2 to start. If it does not open:
      sudo apt install libfuse2t64     (Ubuntu 24.04 and newer)
      sudo apt install libfuse2        (older releases)

EOF
