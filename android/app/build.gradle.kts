// Convert for Android — the one module. Plain WebView wrapper, no native code.
import org.gradle.api.tasks.Sync

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The launcher understands "build-YYYYMMDD" version names; bump this whenever the wrapper
// or the bundled dist/ changes.
val appVersionName = "build-20260921"
val appVersionCode = 20260921

// dist/ is the Vite production build of the repo root — the same bundle the desktop
// (Electron) target serves — plus dist/cache.json, the precomputed format list. It is NOT
// committed; buildWebBundle below produces it, and copyDistToAssets copies it into the APK's
// assets so it can be served locally via WebViewAssetLoader at
// https://appassets.androidplatform.net/convert/…, matching the Vite `base: "/convert/"` the
// bundle is built with.
val repoRoot = rootProject.file("..")
val distDir = File(repoRoot, "dist")
val cacheJson = File(distDir, "cache.json")
val assetsConvertDir = layout.buildDirectory.dir("generated/convertAssets/convert")

/** Looks a command up on PATH so the build fails with advice instead of "command not found". */
fun findOnPath(command: String): File? =
    (System.getenv("PATH") ?: "").split(File.pathSeparator)
        .asSequence()
        .filter { it.isNotBlank() }
        .map { File(it, command) }
        .firstOrNull { it.isFile && it.canExecute() }

val buildWebBundle by tasks.registering {
    description = "Build the web bundle (dist/) and its format precache with npm + node."
    group = "convert"

    // A complete bundle is index.html + cache.json; anything less and we rebuild. Pass
    // -PconvertRebuildBundle to force a rebuild after changing the app's own sources.
    val forced = project.hasProperty("convertRebuildBundle")
    outputs.upToDateWhen { !forced && File(distDir, "index.html").isFile && cacheJson.isFile }

    doLast {
        val node = findOnPath("node") ?: error(
            "node was not found on PATH. The Android wrapper is a thin shell around this " +
                "project's own web build, so Node.js (with npm) is required to produce it. " +
                "Install Node 20+ and re-run, or build dist/ yourself and re-run Gradle.",
        )
        val npm = findOnPath("npm") ?: error("npm was not found on PATH (it ships with Node.js).")
        logger.lifecycle("Using node at ${node.absolutePath}")

        // project.exec streams the (long) npm/vite output straight to the build log; the
        // configuration cache is off for this project, which is what that requires.
        fun run(vararg command: String, environment: Map<String, String> = emptyMap()) {
            val result = project.exec {
                workingDir = repoRoot
                commandLine(*command)
                environment.forEach { (k, v) -> this.environment(k, v) }
                isIgnoreExitValue = true
            }
            if (result.exitValue != 0) {
                error("`${command.joinToString(" ")}` failed with exit code ${result.exitValue}.")
            }
        }

        if (!File(repoRoot, "node_modules").isDirectory) {
            // --ignore-scripts because the postinstall hook is written for Bun; the line below
            // runs that same script under Node instead (see android/tools/node-ts-resolve.mjs).
            val lockfile = File(repoRoot, "package-lock.json").isFile
            logger.lifecycle(if (lockfile) "Running npm ci…" else "Running npm install…")
            run(npm.absolutePath, if (lockfile) "ci" else "install", "--ignore-scripts")
            run(node.absolutePath, "--import", "./android/tools/node-ts-resolve.mjs",
                "scripts/extract-material-icons.ts")
        }

        logger.lifecycle("Building dist/ (tsc + vite)…")
        run(npm.absolutePath, "exec", "--", "tsc")
        run(npm.absolutePath, "exec", "--", "vite", "build",
            environment = mapOf("IS_DESKTOP" to "true"))

        // Without cache.json the app re-probes every handler on each cold start, which costs
        // the user the better part of a minute behind "Loading formats…".
        logger.lifecycle("Building dist/cache.json (format precache)…")
        run(node.absolutePath, "android/tools/build-cache.mjs", "dist", "dist/cache.json", "--minify")

        if (!cacheJson.isFile) error("dist/cache.json was not produced.")
    }
}

val copyDistToAssets by tasks.registering(Sync::class) {
    description = "Copy the repo-root dist/ (web bundle + format precache) into assets/convert/."
    group = "convert"
    dependsOn(buildWebBundle)
    doFirst {
        require(distDir.isDirectory) {
            "dist/ not found at ${distDir.absolutePath} — build it first from the repo root:\n" +
                "  npm install\n" +
                "  npx tsc && IS_DESKTOP=true npx vite build\n" +
                "  node android/tools/build-cache.mjs dist dist/cache.json --minify"
        }
        require(cacheJson.isFile) {
            "dist/cache.json is missing — the app would rebuild its format list on every " +
                "cold start. Run: node android/tools/build-cache.mjs dist dist/cache.json --minify"
        }
    }
    from(distDir)
    into(assetsConvertDir)
}

android {
    namespace = "com.jamesbreedon.convert"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.jamesbreedon.convert"
        minSdk = 29
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName

        ndk { abiFilters += listOf("arm64-v8a") }

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        // Release signing is CI-only, from the suite keystore. No key material exists in
        // this repo; a local assembleRelease without the env vars produces an UNSIGNED apk
        // on purpose. Porters build debug only.
        create("suite") {
            val ksPath = System.getenv("SUITE_KEYSTORE_PATH")
            if (!ksPath.isNullOrBlank() && File(ksPath).isFile) {
                storeFile = File(ksPath)
                storePassword = System.getenv("SUITE_KEYSTORE_PASS")
                keyAlias = System.getenv("SUITE_KEY_ALIAS")
                keyPassword = System.getenv("SUITE_KEYSTORE_PASS")
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (System.getenv("SUITE_KEYSTORE_PATH") != null) {
                signingConfig = signingConfigs.getByName("suite")
            }
        }
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(layout.buildDirectory.dir("generated/convertAssets"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    packaging {
        // There are no native libraries in this wrapper; this just keeps the packaging mode
        // explicit. The large wasm/tar assets stay AAPT-compressed on purpose — it is what
        // holds the APK to ~103MB against a ~275MB dist/.
        jniLibs { useLegacyPackaging = false }
    }
}

tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }
    .configureEach { dependsOn(copyDistToAssets) }
// Release builds run lintVital, whose model writer reads the generated assets dir too (Gradle refuses the
// implicit dependency on release builds).
tasks.matching { it.name.contains("LintVital") || it.name.startsWith("lintVital") }
    .configureEach { dependsOn(copyDistToAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}
