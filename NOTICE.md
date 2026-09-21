# NOTICE — this is a repackaging, not original work

This repository is a **fork of [p2r3/convert](https://github.com/p2r3/convert)** ("Convert to it!" —
<https://convert.to.it>), maintained by **James Breedon only to repackage that project as a standalone
desktop program** for the JBTheatreTools launcher. It is not a new product.

- **All credit for Convert goes to its original authors** (p2r3 and contributors). This fork claims **no
  authorship** of the Convert application itself.
- This fork includes a local cancellation reliability fix: cancelled conversions no longer publish
  results or show conversion-failure messages. Other changes are limited to packaging; desktop builds use the
  project's *own* `desktop:*` (Electron) build targets. No features here are mine.
- The `android/` directory is an additional packaging target: a minimal WebView wrapper (Kotlin/Gradle,
  no native code) that shows this project's own unmodified web UI, built from the same Vite bundle the
  desktop target serves. That wrapper's code (the Android project files, not the UI it displays) is
  James Breedon's packaging work, licensed **GPL-2.0** like the rest of this fork.
- Convert is licensed **GPL-2.0**; this fork is distributed under the **same GPL-2.0 licence** (see
  [`LICENSE`](LICENSE)), with all original copyright and licence notices preserved. The full corresponding
  source is this public repository.
- This fork is **not affiliated with, nor endorsed by,** the original authors.
- **Original project, website, issues and development:** <https://convert.to.it> ·
  <https://github.com/p2r3/convert>.

If you want the project itself — to use the website, report an issue, or contribute — please go to the
original, not here.
