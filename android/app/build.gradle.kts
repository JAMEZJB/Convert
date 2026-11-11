// Convert for Android — the one module. Plain WebView wrapper, no native code.
import org.gradle.api.tasks.Sync

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The launcher understands "build-YYYYMMDD" version names: this is the tag of the desktop
// release the APK goes with. Bump it whenever the wrapper or the bundled web app changes.
val appVersionName = "build-20261108"
val appVersionCode = 20261108

// The web app in the APK is upstream's (p2r3/convert), unmodified, at ONE exact commit: the
// commit the desktop release of the same tag names after "built-from:". Pass it with
// -PupstreamSha=<sha> (or UPSTREAM_SHA in the environment); there is no default.
// android/tools/upstream-bundle.mjs fetches that commit into a build-only folder,
// android/build/upstream/<sha>/, runs upstream's own build there (the same commands the
// desktop build runs) and leaves:
//   src/dist/                 the bundle, with cache.json, the precomputed format list
//   convert-built-from.txt    "built-from: <sha>", written only once the bundle is complete
// Neither is committed. copyDistToAssets copies both into the APK's assets: the bundle to
// assets/convert/, served locally via WebViewAssetLoader at
// https://appassets.androidplatform.net/convert/…, and the note beside it as
// assets/convert-built-from.txt, so any APK can be traced to the source it was built from.
val upstreamSha = (findProperty("upstreamSha")?.toString() ?: System.getenv("UPSTREAM_SHA") ?: "")
    .trim().lowercase()
val upstreamShaGiven = Regex("[0-9a-f]{40}").matches(upstreamSha)
// Without a usable sha this names a folder that is never created; buildWebBundle stops the
// build before anything looks inside it.
val upstreamDir = File(
    rootProject.file("build/upstream"),
    if (upstreamShaGiven) upstreamSha else "no-commit-given",
)
val distDir = File(upstreamDir, "src/dist")
val builtFromFile = File(upstreamDir, "convert-built-from.txt")
val assetsDir = layout.buildDirectory.dir("generated/convertAssets")

/** Looks a command up on PATH so the build fails with advice instead of "command not found". */
fun findOnPath(command: String): File? =
    (System.getenv("PATH") ?: "").split(File.pathSeparator)
        .asSequence()
        .filter { it.isNotBlank() }
        .map { File(it, command) }
        .firstOrNull { it.isFile && it.canExecute() }

val buildWebBundle by tasks.registering {
    description = "Fetch upstream at -PupstreamSha and build its web bundle in android/build/upstream/."
    group = "convert"

    // The script does nothing when this commit's bundle is already complete. Pass
    // -PconvertRebuildBundle to make it run upstream's build again.
    val rebuild = project.hasProperty("convertRebuildBundle")

    doLast {
        if (!upstreamShaGiven) {
            val given = if (upstreamSha.isEmpty()) "" else " (\"$upstreamSha\" is not a full 40-character sha)"
            error(
                "No upstream commit to build the web app from$given. Pass -PupstreamSha=<sha> " +
                    "(or set UPSTREAM_SHA): the 40-character commit printed after \"built-from:\" " +
                    "in the desktop release this APK is to match.",
            )
        }
        val node = findOnPath("node") ?: error(
            "node was not found on PATH. Node.js 20+ runs android/tools/upstream-bundle.mjs, " +
                "which fetches upstream and runs its build. Install it and re-run.",
        )
        val command = mutableListOf(
            node.absolutePath,
            rootProject.file("tools/upstream-bundle.mjs").absolutePath,
            "--sha", upstreamSha,
            "--dir", upstreamDir.absolutePath,
        )
        if (rebuild) command.add("--rebuild")

        // project.exec streams the (long) build output straight to the build log; the
        // configuration cache is off for this project, which is what that requires.
        val result = project.exec {
            workingDir = rootProject.projectDir
            commandLine(command)
            isIgnoreExitValue = true
        }
        if (result.exitValue != 0) {
            error("The upstream bundle was not built (exit code ${result.exitValue}); the reason is in the output above.")
        }
    }
}

val copyDistToAssets by tasks.registering(Sync::class) {
    description = "Copy the upstream bundle and its built-from note into the APK's assets."
    group = "convert"
    dependsOn(buildWebBundle)
    doFirst {
        require(builtFromFile.isFile && File(distDir, "index.html").isFile && File(distDir, "cache.json").isFile) {
            "No complete upstream bundle in ${upstreamDir.absolutePath}. Run the build with " +
                "-PupstreamSha=<sha> so buildWebBundle can produce it."
        }
    }
    from(distDir) { into("convert") }
    from(builtFromFile)
    into(assetsDir)
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
