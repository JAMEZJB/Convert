"""Pack PNG files into a multi-resolution Windows .ico — stdlib only.

Uses the PNG-in-ICO form (each image stored as a PNG blob), supported by Windows Vista+.
Usage: python make_ico.py out.ico 16.png 32.png 48.png 64.png 128.png 256.png
"""

import struct
import sys


def main(argv):
    if len(argv) < 3:
        print("usage: make_ico.py <out.ico> <png> [png ...]")
        return 2
    out, pngs = argv[1], argv[2:]
    images = []
    for p in pngs:
        with open(p, "rb") as fh:
            data = fh.read()
        # PNG IHDR width/height live at byte offset 16..24 (big-endian uint32 each).
        w = struct.unpack(">I", data[16:20])[0]
        h = struct.unpack(">I", data[20:24])[0]
        images.append((w, h, data))

    n = len(images)
    header = struct.pack("<HHH", 0, 1, n)            # reserved, type=1 (icon), count
    offset = 6 + 16 * n
    entries, blobs = b"", b""
    for w, h, data in images:
        entries += struct.pack(
            "<BBBBHHII",
            w if w < 256 else 0, h if h < 256 else 0,  # 0 means 256
            0, 0, 1, 32, len(data), offset,
        )
        blobs += data
        offset += len(data)

    with open(out, "wb") as fh:
        fh.write(header + entries + blobs)
    print(f"wrote {out} ({n} sizes, {offset} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
