#!/bin/bash
###############################################################################
# Generate the Convert launcher icon from make_icon.swift, using macOS built-ins.
# PACKAGING CHROME ONLY (the .app/.exe + JBTheatreTools catalog tile) — the upstream
# app UI is untouched (fork = p2r3/convert "unmodified except for packaging").
#
#   make_icon.swift --(swift/AppKit)--> icon_1024.png   (house art: dark squircle,
#                     azure convert-⇄, "CONV" wordmark — same family as the siblings)
#   icon_1024.png   --(sips/iconutil)--> AppIcon.icns    (mac  — electron-builder mac.icon)
#                   --(sips + make_ico.py)--> app.ico     (win  — electron-builder win.icon)
#
# Run on macOS:  bash make_icon.sh
###############################################################################
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Rendering master art (swift make_icon.swift)…"
swift make_icon.swift
SRC="icon_1024.png"
[ -f "$SRC" ] || { echo "ERROR: swift did not produce $SRC"; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "==> Building AppIcon.icns…"
ICONSET="$TMP/AppIcon.iconset"; mkdir -p "$ICONSET"
for SZ in 16 32 128 256 512; do
  sips -z $SZ $SZ "$SRC" --out "$ICONSET/icon_${SZ}x${SZ}.png" >/dev/null
  D=$((SZ * 2)); sips -z $D $D "$SRC" --out "$ICONSET/icon_${SZ}x${SZ}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "AppIcon.icns"

echo "==> Building app.ico…"
ICODIR="$TMP/ico"; mkdir -p "$ICODIR"; ICO_PNGS=()
for SZ in 16 32 48 64 128 256; do
  sips -z $SZ $SZ "$SRC" --out "$ICODIR/$SZ.png" >/dev/null
  ICO_PNGS+=("$ICODIR/$SZ.png")
done
python3 make_ico.py "app.ico" "${ICO_PNGS[@]}"

echo "==> Done: AppIcon.icns + app.ico + icon_1024.png"
