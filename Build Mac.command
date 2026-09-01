#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Double-click this file in Finder to build the macOS release.
#
# It runs build.sh: checks, tests, signing, notarization, stapling and
# verification. The first time, it asks for your Apple ID and an app-specific
# password, then stores them in your keychain and never asks again.
#
# The window stays open at the end so you can read the result.
# -----------------------------------------------------------------------------

# Finder starts the Terminal in your home folder, so move to this file's folder.
cd "$(dirname "${BASH_SOURCE[0]}")" || { echo "Cannot reach the renamo folder."; exit 1; }

./build.sh
STATUS=$?

echo
if [ $STATUS -eq 0 ]; then
  echo "  BUILD OK - the DMG in dist/ is ready to upload."
else
  echo "  BUILD FAILED - read the message above (exit code $STATUS)."
fi
echo "  Press return to close this window."
read -r _
exit $STATUS
