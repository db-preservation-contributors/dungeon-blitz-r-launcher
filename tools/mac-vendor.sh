#!/bin/sh
set -e
app="$1"
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$app/Contents/Resources/vendor"
rm -rf "$dest"
for dir in "$root"/vendor/*/darwin; do
  [ -d "$dir" ] || continue
  kind="$(basename "$(dirname "$dir")")"
  mkdir -p "$dest/$kind"
  ditto "$dir" "$dest/$kind/darwin"
done
codesign --force --deep --sign - "$app" 2>/dev/null || true
if [ -n "$2" ]; then
  stage="$(mktemp -d)"
  ditto "$app" "$stage/$(basename "$app")"
  ln -s /Applications "$stage/Applications"
  hdiutil create -volname "Dungeon Blitz R" -srcfolder "$stage" -ov -format UDZO "$2"
  rm -rf "$stage"
fi
