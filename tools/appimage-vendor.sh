#!/bin/sh
# Puts the original vendor/ files back into the AppImage Tauri built, then checks them.
#
# linuxdeploy (Tauri's AppImage step) patches every ELF file under usr/lib, and the resources
# live there too: it gives flashplayer and the preload libraries a $ORIGIN RUNPATH. Their bytes
# then no longer match the fingerprints built into the launcher, which refuses to start
# ("Flash Player files were changed after installation"). That is what broke 1.12.0's AppImage.
#
# The AppImage is the runtime (an ELF file) followed by a squashfs image. This unpacks the image,
# copies each vendor file back from vendor/, packs it again and puts the same runtime in front.
#
# Usage: tools/appimage-vendor.sh <in.AppImage> <out.AppImage>
# Needs: python3, unsquashfs and mksquashfs (squashfs-tools), node.
set -eu

in="$1"
out="$2"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Where the squashfs starts: the end of the runtime's ELF section headers.
image_offset() {
  python3 -I -c '
import struct, sys
with open(sys.argv[1], "rb") as f:
    head = f.read(64)
if head[:4] != b"\x7fELF" or head[4] != 2:
    sys.exit("not a 64-bit ELF AppImage runtime")
shoff = struct.unpack_from("<Q", head, 0x28)[0]
entsize, count = struct.unpack_from("<HH", head, 0x3A)
print(shoff + entsize * count)
' "$1"
}

product="$(node -p "require('$root/src-tauri/tauri.conf.json').productName")"
offset="$(image_offset "$in")"
unsquashfs -no-progress -no-xattrs -o "$offset" -d "$work/AppDir" "$in" >/dev/null
vendor="$work/AppDir/usr/lib/$product/vendor"
[ -d "$vendor" ] || { echo "[appimage-vendor] no $product/vendor in $in" >&2; exit 1; }

# One name per line: the AIR bundle has names with spaces in them ("Adobe AIR").
(cd "$vendor" && find . -type f | sed 's|^\./||') > "$work/vendor-files"
count=0
while IFS= read -r file; do
  cp "$root/vendor/$file" "$vendor/$file"
  count=$((count + 1))
done < "$work/vendor-files"
echo "[appimage-vendor] restored $count vendor files"

comp="$(unsquashfs -s -o "$offset" "$in" | sed -n 's/^Compression //p')"
block="$(unsquashfs -s -o "$offset" "$in" | sed -n 's/^Block size //p')"
mksquashfs "$work/AppDir" "$work/image" -root-owned -no-xattrs -noappend -no-progress -comp "${comp:-zstd}" -b "${block:-131072}" >/dev/null
head -c "$offset" "$in" > "$out"
cat "$work/image" >> "$out"
chmod +x "$out"

# Check the copies in the finished file, the same way the launcher will.
rm -rf "$work/check"
unsquashfs -no-progress -no-xattrs -o "$(image_offset "$out")" -d "$work/check" "$out" >/dev/null
checked="$work/check/usr/lib/$product/vendor"
node "$root/tools/verify-projector.js" "$checked/projector/linux/flashplayer" --platform linux
node "$root/tools/build-flash-preload.js" --check "$checked/flashpreload/linux"
node "$root/tools/build-air.js" --check "$checked/air/win32/DungeonBlitzR" --platform win32
node "$root/tools/build-wine.js" --check "$checked/wine/linux/wine"
