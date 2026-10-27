#!/bin/bash
# Read-only readiness report. Does not read logins, environment secrets, project
# contents or Studio sessions; does not install anything or change permissions.
set -u
printf 'SSAM native macOS readiness\n'
printf 'Architecture: '; /usr/bin/uname -m
printf 'macOS: '; /usr/bin/sw_vers -productVersion
printf 'Developer tools: '
/usr/bin/xcode-select -p 2>/dev/null || printf 'not installed\n'
printf 'C compiler: '
/usr/bin/xcrun --find clang 2>/dev/null || printf 'not available\n'
printf '.NET SDK: '
if command -v dotnet >/dev/null 2>&1; then dotnet --version 2>/dev/null || printf 'SDK not installed\n';
else printf 'not installed\n'; fi
printf '\nStudio application bundles:\n'
found=0
for bundle in /Applications/*.app /Applications/*/*.app "$HOME"/Applications/*.app "$HOME"/Applications/*/*.app; do
  [ -d "$bundle/Contents" ] || continue
  [ -L "$bundle" ] && continue
  entry=$(/usr/bin/find "$bundle/Contents" -type f \( -name ODCStudio.dll -o -name ServiceStudio.dll \) -print -quit 2>/dev/null)
  [ -n "$entry" ] || continue
  found=1
  printf 'Bundle: %s\n' "${bundle##*/}"
  printf '  Entry assembly: %s\n' "${entry##*/}"
  printf '  Version: '
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$bundle/Contents/Info.plist" 2>/dev/null || printf 'not declared\n'
done
[ "$found" -eq 1 ] || printf 'No Studio found in /Applications or ~/Applications.\n'
printf '\nEnd of report. No installation or Studio session was changed.\n'
