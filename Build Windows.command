#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Double-click this file in Finder to build the Windows version from your Mac.
#
# With Wine installed you get the .exe installer plus a portable .zip; without
# it, only the portable .zip. The Windows build is not signed, so SmartScreen
# still warns on first launch: "More info" then "Run anyway".
#
# The window stays open at the end so you can read the result.
# -----------------------------------------------------------------------------

# Finder starts the Terminal in your home folder, so move to this file's folder.
cd "$(dirname "${BASH_SOURCE[0]}")" || { echo "Cannot reach the renamo folder."; exit 1; }

./build.sh --win
STATUS=$?

echo
if [ $STATUS -eq 0 ]; then
  echo "  BUILD OK - the Windows files are in dist/."
else
  echo "  BUILD FAILED - read the message above (exit code $STATUS)."
fi
echo "  Press return to close this window."
read -r _
exit $STATUS
