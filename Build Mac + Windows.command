#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Double-click this file in Finder to build both releases in one run:
# the signed and notarized macOS DMG, then the Windows installer.
#
# This is the one to use on release day. Count a few minutes for Apple's answer.
#
# The window stays open at the end so you can read the result.
# -----------------------------------------------------------------------------

# Finder starts the Terminal in your home folder, so move to this file's folder.
cd "$(dirname "${BASH_SOURCE[0]}")" || { echo "Cannot reach the renamo folder."; exit 1; }

./build.sh --all
STATUS=$?

echo
if [ $STATUS -eq 0 ]; then
  echo "  BUILD OK - everything you need to upload is in dist/."
else
  echo "  BUILD FAILED - read the message above (exit code $STATUS)."
fi
echo "  Press return to close this window."
read -r _
exit $STATUS
