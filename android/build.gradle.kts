// Convert for Android — root build file.
//
// Toolchain pinned to match the rest of the suite's Android tooling: AGP 8.9.2 / Kotlin
// 2.0.21 / Gradle wrapper 8.13, compileSdk 35, JDK 17. This is a plain WebView wrapper
// (no Chaquopy, no native code) around the same Vite bundle the desktop (Electron) build
// serves — see app/README in this directory for how the bundle is fetched into assets.
plugins {
    id("com.android.application") version "8.9.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
