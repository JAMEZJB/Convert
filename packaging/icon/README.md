# Launcher icon — packaging chrome only

This directory holds the **launcher/app icon** for the Convert repackage: the icon baked into the
built `.app` / `.exe` by [`desktop-build.yml`](../../.github/workflows/desktop-build.yml) (electron-builder
`-c.mac.icon` / `-c.win.icon`) and the tile shown in the JBTheatreTools launcher grid.

It is **packaging only.** The application itself is [p2r3/convert](https://github.com/p2r3/convert),
**unmodified except for packaging** — this icon does **not** change the app's UI, its in-window
branding, or its favicon. See [`../../NOTICE.md`](../../NOTICE.md).

## Regenerate (macOS, built-ins only)

```bash
bash make_icon.sh
```

- `make_icon.swift` (AppKit) renders the master art → `icon_1024.png`
- `sips` + `iconutil` → `AppIcon.icns` (macOS)
- `sips` + `make_ico.py` (stdlib) → `app.ico` (Windows)

## Art

House dark squircle (`#20242B`, ~22.5% corner radius); a convert-⇄ glyph in Convert's owned accent
**azure `#2F86D6`**; heavy white **CONV** wordmark in the lower band. Geometry is transcribed 1:1 from
the design spec. `icon_1024.png` is also the master PNG for the JBTheatreTools catalog tile.
