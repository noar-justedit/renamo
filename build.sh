#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# renamo - build script (macOS)
# -----------------------------------------------------------------------------
#   ./build.sh                 everything: checks, tests, signed and notarized DMG
#   ./build.sh --all           the same, plus the Windows build
#   ./build.sh --win           Windows only (.exe if Wine is installed, else .zip)
#   ./build.sh --dev           run the app without building
#   ./build.sh --no-notarize   unsigned macOS build, for local testing only
#   ./build.sh --skip-tests    skip the rename-engine tests
#   ./build.sh --setup         re-enter the Apple credentials, then exit
#
# The first signed build asks for your Apple ID and an app-specific password, then
# stores them in your keychain under the "renamo-notarization" profile. It never
# asks again, and nothing secret is written into this folder.
# -----------------------------------------------------------------------------
set -euo pipefail

# Resolve the script before moving: $0 may be relative to the caller's directory.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
cd "$(dirname "$SELF")"

APP="renamo"
PROFILE="${NOTARY_PROFILE:-renamo-notarization}"
VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")

DO_MAC=1; DO_WIN=0; DO_TESTS=1; NOTARIZE=1; DEV=0; SETUP_ONLY=0

# ${1+"$@"} instead of "$@": macOS still ships bash 3.2, where an empty "$@"
# trips `set -u`.
for arg in ${1+"$@"}; do
  case "$arg" in
    --all)         DO_WIN=1 ;;
    --win)         DO_WIN=1; DO_MAC=0 ;;
    --dev)         DEV=1 ;;
    --no-notarize) NOTARIZE=0 ;;
    --skip-tests)  DO_TESTS=0 ;;
    --setup)       SETUP_ONLY=1 ;;
    -h|--help)     sed -n "2,16p" "$SELF"; exit 0 ;;
    *) echo "  Unknown option: $arg   (try ./build.sh --help)"; exit 1 ;;
  esac
done

# ── small helpers ────────────────────────────────────────────────────────────
step() { printf '\n  %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\n  STOP: %s\n\n' "$*" >&2; exit 1; }

banner() {
  printf '\n  %s  v%s\n' "$APP" "$VERSION"
  printf '  %s\n' "-----------------------------"
}

need_macos() {
  [ "$(uname)" = "Darwin" ] || die "the macOS build only runs on a Mac."
}

need_node() {
  command -v node >/dev/null 2>&1 || die "Node.js is required. Install it with: brew install node"
  local major minor
  major=$(node -p "process.versions.node.split('.')[0]")
  minor=$(node -p "process.versions.node.split('.')[1]")
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 12 ]; }; then
    die "Node $(node -v) is too old for notarization (needs 22.12 or newer). Run: brew upgrade node"
  fi
}

need_xcode_tools() {
  xcrun --find notarytool >/dev/null 2>&1 || die \
"Apple's command line tools are missing or out of date.
       Install them with:  xcode-select --install
       Then re-run this script."
}

# The certificate common name ends with the team ID: "Developer ID Application: X (ABCDE12345)"
IDENTITY=""; TEAM_ID=""
find_identity() {
  local line
  line=$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" | head -1 || true)
  [ -n "$line" ] || die \
"no \"Developer ID Application\" certificate in your keychain.
       Create one on developer.apple.com > Certificates, download it and double-click it.
       To build without signing in the meantime:  ./build.sh --no-notarize"
  IDENTITY=$(printf '%s' "$line" | sed -E 's/.*"(.*)".*/\1/')
  TEAM_ID=$(printf '%s' "$IDENTITY" | sed -E 's/.*\(([A-Z0-9]{10})\)$/\1/')
  [ ${#TEAM_ID} -eq 10 ] || die "could not read the team ID from the certificate \"$IDENTITY\"."
}

setup_profile() {
  [ -t 0 ] || die "notarization is not configured and this shell is not interactive. Run ./build.sh --setup by hand."
  printf '\n'
  info "First signed build: I need your Apple credentials once."
  info ""
  info "  Apple ID              the email of your Apple Developer account"
  info "  App-specific password create one at appleid.apple.com >"
  info "                        Sign-In and Security > App-Specific Passwords"
  info "                        (NOT your Apple ID password)"
  info ""
  info "  Team ID               $TEAM_ID  (read from your certificate)"
  printf '\n'
  local apple_id apple_pw
  printf '  Apple ID: '
  read -r apple_id
  [ -n "$apple_id" ] || die "no Apple ID given."
  printf '  App-specific password: '
  read -rs apple_pw
  printf '\n'
  [ -n "$apple_pw" ] || die "no password given."
  step "Storing them in your keychain as \"$PROFILE\"..."
  xcrun notarytool store-credentials "$PROFILE" \
    --apple-id "$apple_id" --team-id "$TEAM_ID" --password "$apple_pw" >/dev/null \
    || die "Apple refused these credentials. Check the Apple ID and generate a fresh app-specific password."
  info "Saved. You will not be asked again."
}

# Validate the profile, and tell a missing profile apart from a network problem.
ensure_profile() {
  local out
  if out=$(xcrun notarytool history --keychain-profile "$PROFILE" 2>&1); then
    return 0
  fi
  if printf '%s' "$out" | grep -qiE "keychain|profile|credential|not found"; then
    setup_profile
    xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 \
      || die "the credentials were stored but Apple still refuses them. Try ./build.sh --setup again."
  else
    die "notarytool could not reach Apple:
       $(printf '%s' "$out" | head -3)"
  fi
}

# Submit an artifact, wait for the verdict, and print Apple's log if it is rejected.
notarize_file() {
  local target="$1" label="$2" out id
  step "Sending the $label to Apple. This usually takes 2 to 10 minutes..."
  if ! out=$(xcrun notarytool submit "$target" --keychain-profile "$PROFILE" --wait 2>&1); then
    printf '%s\n' "$out" | sed 's/^/    /'
    id=$(printf '%s' "$out" | awk -F': ' '/^ *id: /{print $2; exit}')
    if [ -n "$id" ]; then
      step "Apple's reasons:"
      xcrun notarytool log "$id" --keychain-profile "$PROFILE" 2>&1 | sed 's/^/    /' || true
    fi
    die "Apple rejected the $label."
  fi
  info "Accepted."
  step "Stapling the ticket into the $label..."
  xcrun stapler staple "$target" >/dev/null || die "could not staple the ticket into the $label."
  xcrun stapler validate "$target" >/dev/null || die "the $label carries no valid ticket after stapling."
  info "Done."
}

install_deps() {
  if [ ! -d node_modules ]; then
    step "Installing dependencies..."
    npm install
  fi
}

run_tests() {
  [ "$DO_TESTS" = "1" ] || return 0
  step "Running the rename-engine tests..."
  npm test
}

build_windows() {
  step "Building Windows (x64)..."
  if command -v wine >/dev/null 2>&1 || command -v wine64 >/dev/null 2>&1; then
    npx electron-builder --win nsis zip --x64
  else
    info "Wine is not installed, so the .exe installer cannot be assembled here."
    info "To get it:  brew install --cask wine-stable"
    info "Building the portable .zip instead..."
    npx electron-builder --win zip --x64
  fi
}

# ── dev mode ─────────────────────────────────────────────────────────────────
if [ "$DEV" = "1" ]; then
  banner
  need_node; install_deps
  step "Launching in dev mode..."
  npm start
  exit 0
fi

# ── credentials only ─────────────────────────────────────────────────────────
if [ "$SETUP_ONLY" = "1" ]; then
  banner
  need_macos; need_xcode_tools; find_identity
  info "Certificate: $IDENTITY"
  setup_profile
  printf '\n'
  exit 0
fi

banner
START=$SECONDS
need_node

# ── macOS ────────────────────────────────────────────────────────────────────
if [ "$DO_MAC" = "1" ]; then
  need_macos
  if [ "$NOTARIZE" = "1" ]; then
    need_xcode_tools
    find_identity
    info "Certificate    : $IDENTITY"
    info "Notary profile : $PROFILE"
    ensure_profile
  else
    export SKIP_NOTARIZE=1
    info "Unsigned build (--no-notarize): for local testing only."
  fi
fi

install_deps
run_tests

# Start from a clean dist/ so the summary only lists this build.
rm -rf dist

DMG="dist/$APP-$VERSION-mac-arm64.dmg"
APP_PATH="dist/mac-arm64/$APP.app"

if [ "$DO_MAC" = "1" ]; then
  step "Building macOS (Apple Silicon)..."
  if [ "$NOTARIZE" = "1" ]; then
    info "The app is signed, then notarized: Apple's answer takes a few minutes."
  fi
  npm run build:mac

  if [ "$NOTARIZE" = "1" ]; then
    # The app was notarized and stapled by the afterSign hook before the DMG was
    # assembled. The DMG is a separate container that electron-builder leaves
    # unsigned, and Apple rejects an unsigned disk image, so sign it here.
    # --timestamp is what makes the signature notarizable.
    step "Signing the disk image..."
    codesign --force --sign "$IDENTITY" --timestamp "$DMG" || die "could not sign the DMG."
    codesign --verify --strict "$DMG" || die "the DMG signature did not verify."
    info "Signed with $IDENTITY"

    # Stapling then means a freshly downloaded DMG also opens with no network
    # round trip.
    notarize_file "$DMG" "disk image"

    step "Final check:"
    codesign --verify --deep --strict "$APP_PATH" || die "the signature of the built app is broken."
    info "app signature   OK"
    codesign --verify --strict "$DMG" || die "the signature of the DMG is broken."
    info "DMG signature   OK"
    xcrun stapler validate "$APP_PATH" >/dev/null || die "the app carries no notarization ticket."
    info "app ticket      OK"
    xcrun stapler validate "$DMG" >/dev/null || die "the DMG carries no notarization ticket."
    info "DMG ticket      OK"
    # What Gatekeeper will say on the user's machine, for the app and for the
    # disk image they actually download.
    if SPCTL=$(spctl -a -t exec -vv "$APP_PATH" 2>&1); then
      printf '%s\n' "$SPCTL" | sed 's/^/    /'
    else
      printf '%s\n' "$SPCTL" | sed 's/^/    /'
      die "Gatekeeper refuses this app. Do not ship it."
    fi
    if SPCTL=$(spctl -a -t open --context context:primary-signature -vv "$DMG" 2>&1); then
      printf '%s\n' "$SPCTL" | sed 's/^/    /'
    else
      printf '%s\n' "$SPCTL" | sed 's/^/    /'
      die "Gatekeeper refuses this disk image. Do not ship it."
    fi
  fi
fi

if [ "$DO_WIN" = "1" ]; then
  build_windows
fi

# ── summary ──────────────────────────────────────────────────────────────────
ELAPSED=$((SECONDS - START))
printf '\n  Done in %dm%02ds.\n\n' $((ELAPSED / 60)) $((ELAPSED % 60))
if [ "$DO_MAC" = "1" ]; then
  if [ "$NOTARIZE" = "1" ]; then
    info "READY TO SHIP"
    info "  $DMG"
    info "  signed, notarized and stapled - it opens with a double-click on any Mac."
  else
    info "NOT SHIPPABLE: unsigned build."
    info "  $DMG"
    info "  first launch needs right-click > Open. Re-run ./build.sh for a real release."
  fi
fi
if [ "$DO_WIN" = "1" ]; then
  printf '\n'
  info "Windows (unsigned, SmartScreen shows a warning):"
  ls -1 dist/*.exe dist/*win*.zip 2>/dev/null | sed 's/^/    /' || info "  (check dist/)"
fi
printf '\n'
