// Checks how the Android build gets its web app, without Gradle, Bun or the network.
//
// upstream-bundle.mjs is run against small git repositories this test makes in a temporary
// folder (standing in for upstream), with upstream's build replaced by a stand-in that writes
// a bundle. The Gradle file and the desktop workflow are read for the wiring a script cannot
// show.
//
// Usage: node android/tools/upstream-bundle.test.mjs [path to an android/ directory]
// Needs only Node 20+ and git; nothing is installed, opened or contacted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const androidDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const {
  BUILD_COMMANDS, BundleError, MARKER_NAME, UPSTREAM_REMOTE, buildBundle, checkSha, findOnPath,
  main, markerText, parseArgs, prepareSource, startedAsScript, upstreamBundle,
} = await import(pathToFileURL(join(androidDir, "tools", "upstream-bundle.mjs")).href);

const gradle = readFileSync(join(androidDir, "app", "build.gradle.kts"), "utf8");

const SHA = "0123456789abcdef0123456789abcdef01234567";

// --- stand-ins ------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "upstream-bundle-test-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
let folders = 0;
const folder = (name) => {
  const made = join(scratch, `${++folders}-${name}`);
  mkdirSync(made, { recursive: true });
  return made;
};

/** git for building the stand-in repositories: no user or system configuration, no hooks. */
function fixtureGit(cwd, ...args) {
  return execFileSync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args,
  ], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

/** A repository standing in for upstream: two commits, so "the tip" and "the sha" differ. */
function fakeUpstream() {
  const repo = folder("upstream");
  fixtureGit(repo, "init", "-q", "-b", "master");
  // A commit that is not a branch tip can only be fetched by sha when the remote allows it,
  // as GitHub does for upstream.
  fixtureGit(repo, "config", "uploadpack.allowAnySHA1InWant", "true");
  writeFileSync(join(repo, "app.txt"), "first\n");
  fixtureGit(repo, "add", ".");
  fixtureGit(repo, "commit", "-q", "-m", "first");
  const first = fixtureGit(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "app.txt"), "second\n");
  fixtureGit(repo, "commit", "-q", "-am", "second");
  const second = fixtureGit(repo, "rev-parse", "HEAD");
  return { repo, first, second };
}

/** Stands in for upstream's build: records what was run and writes a complete bundle. */
function fakeBuild({ cache = '[["handler",[]]]', index = true, fail = false } = {}) {
  const ran = [];
  const run = (command, args, cwd) => {
    ran.push([command, ...args]);
    if (fail) throw new BundleError("the stand-in build failed");
    if (args.join(" ") !== "run desktop:build") return;
    mkdirSync(join(cwd, "dist"), { recursive: true });
    if (index) writeFileSync(join(cwd, "dist", "index.html"), `<p>${readFileSync(join(cwd, "app.txt"), "utf8")}</p>`);
    if (cache !== null) writeFileSync(join(cwd, "dist", "cache.json"), cache);
  };
  return { ran, run };
}

const bundleError = (pattern) => (e) => {
  assert.ok(e instanceof BundleError, `expected a BundleError, got ${e}`);
  assert.match(e.message, pattern);
  return true;
};

// --- which commit ---------------------------------------------------------------------------

test("a missing commit stops the build and says where the sha comes from", () => {
  assert.throws(() => checkSha(undefined), bundleError(/No upstream commit was given.*built-from:/s));
  assert.throws(() => checkSha("   "), bundleError(/No upstream commit was given/));
  assert.throws(() => parseArgs([], {}, "/a"), bundleError(/--sha <sha> \(or set UPSTREAM_SHA\)/));
});

test("a shortened or malformed sha is refused, never resolved to something else", () => {
  for (const bad of ["0123456", SHA.slice(0, 39), `${SHA}0`, "master", "HEAD", SHA.replace("0", "g"), `../${SHA}`]) {
    assert.throws(() => checkSha(bad), bundleError(/not a full commit sha/), bad);
  }
  assert.equal(checkSha(` ${SHA.toUpperCase()}\n`), SHA, "case and surrounding space do not matter");
});

test("the command line takes the sha from --sha, then UPSTREAM_SHA, and builds under android/build", () => {
  const other = "f".repeat(40);
  assert.equal(parseArgs(["--sha", SHA], { UPSTREAM_SHA: other }, "/a").sha, SHA);
  const fromEnv = parseArgs([], { UPSTREAM_SHA: other }, "/a");
  assert.equal(fromEnv.sha, other);
  assert.equal(fromEnv.dir, resolve("/a", "build", "upstream", other));
  assert.equal(fromEnv.remote, UPSTREAM_REMOTE);
  assert.equal(fromEnv.rebuild, false);
  const all = parseArgs(["--rebuild", "--dir", "/x/y", "--remote", "/some/mirror", "--sha", SHA], {}, "/a");
  assert.deepEqual(all, { sha: SHA, dir: resolve("/x/y"), remote: "/some/mirror", rebuild: true });
  assert.throws(() => parseArgs(["--sha"], {}, "/a"), bundleError(/--sha needs a value/));
  assert.throws(() => parseArgs(["--sha", SHA, "--fast"], {}, "/a"), bundleError(/Unknown option --fast/));
});

test("upstream is the default remote", () => {
  assert.equal(UPSTREAM_REMOTE, "https://github.com/p2r3/convert.git");
});

// --- the source -----------------------------------------------------------------------------

test("the build folder holds upstream at exactly the given commit, not its newest", () => {
  const up = fakeUpstream();
  const src = join(folder("build"), "src");
  assert.equal(prepareSource({ sha: up.first, src, remote: up.repo }), up.first);
  assert.equal(readFileSync(join(src, "app.txt"), "utf8"), "first\n");
  assert.equal(fixtureGit(src, "rev-parse", "HEAD"), up.first);

  const newer = join(folder("build"), "src");
  prepareSource({ sha: up.second, src: newer, remote: up.repo });
  assert.equal(readFileSync(join(newer, "app.txt"), "utf8"), "second\n");
});

test("a commit upstream does not have stops the build with the sha in the message", () => {
  const up = fakeUpstream();
  const src = join(folder("build"), "src");
  assert.throws(
    () => prepareSource({ sha: SHA, src, remote: up.repo }),
    bundleError(new RegExp(`Commit ${SHA} could not be fetched from .*built-from:`, "s")),
  );
});

test("an unreachable remote stops the build", () => {
  const src = join(folder("build"), "src");
  assert.throws(
    () => prepareSource({ sha: SHA, src, remote: join(scratch, "no-such-remote") }),
    bundleError(/could not be fetched/),
  );
});

test("running again puts back an upstream file an interrupted build left changed, and keeps build output", () => {
  const up = fakeUpstream();
  const src = join(folder("build"), "src");
  prepareSource({ sha: up.first, src, remote: up.repo });
  writeFileSync(join(src, "app.txt"), "changed by something\n");
  mkdirSync(join(src, "node_modules"));
  writeFileSync(join(src, "node_modules", "kept.txt"), "kept");
  // The remote is gone now: a second run must not need it for a commit it already has.
  prepareSource({ sha: up.first, src, remote: join(scratch, "no-such-remote") });
  assert.equal(readFileSync(join(src, "app.txt"), "utf8"), "first\n");
  assert.equal(readFileSync(join(src, "node_modules", "kept.txt"), "utf8"), "kept");
});

test("the checkout around the build folder is never touched", () => {
  // The build folder lives inside this fork's own checkout. Stand in for that checkout with a
  // repository whose state must come through untouched whatever the build folder looks like.
  const up = fakeUpstream();
  const fork = folder("fork");
  fixtureGit(fork, "init", "-q", "-b", "master");
  writeFileSync(join(fork, ".gitignore"), "android/build/\n");
  writeFileSync(join(fork, "app.txt"), "the fork's own copy\n");
  fixtureGit(fork, "add", ".");
  fixtureGit(fork, "commit", "-q", "-m", "fork");
  const before = fixtureGit(fork, "rev-parse", "HEAD");
  const untouched = () => {
    assert.equal(fixtureGit(fork, "rev-parse", "HEAD"), before);
    assert.equal(fixtureGit(fork, "symbolic-ref", "--short", "HEAD"), "master", "the fork must stay on its branch");
    assert.equal(fixtureGit(fork, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(fork, "app.txt"), "utf8"), "the fork's own copy\n");
  };

  const src = join(fork, "android", "build", "upstream", up.first, "src");
  prepareSource({ sha: up.first, src, remote: up.repo });
  assert.equal(readFileSync(join(src, "app.txt"), "utf8"), "first\n");
  untouched();

  // A build folder that holds files but is no repository: refused, not "repaired" by running
  // git there (git would otherwise find the fork's repository above it and act on that).
  const stray = join(fork, "android", "build", "upstream", up.second, "src");
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, "leftover.txt"), "x");
  assert.throws(() => prepareSource({ sha: up.second, src: stray, remote: up.repo }), bundleError(/not a checkout made by this script/));
  untouched();

  // A build folder whose .git is broken: git must fail there rather than fall back to the fork.
  const broken = join(fork, "android", "build", "upstream", "broken", "src");
  mkdirSync(join(broken, ".git"), { recursive: true });
  assert.throws(() => prepareSource({ sha: up.second, src: broken, remote: up.repo }), bundleError(/not a git repository of its own/));
  untouched();
});

// --- the build ------------------------------------------------------------------------------

test("upstream's build is run with the desktop build's own commands, in its order, in the build folder", () => {
  const ran = [];
  buildBundle({ src: "/build/src", bun: "/opt/bun", run: (command, args, cwd) => ran.push([command, args.join(" "), cwd]) });
  assert.deepEqual(ran, [
    ["/opt/bun", "install", "/build/src"],
    ["/opt/bun", "run desktop:build", "/build/src"],
  ]);

  // The desktop workflow is the reference: every command here must be a step it runs, in the
  // same order, in each of its build jobs.
  const workflow = readFileSync(join(androidDir, "..", ".github", "workflows", "desktop-build.yml"), "utf8");
  const steps = BUILD_COMMANDS.map((command) => command.join(" "));
  assert.deepEqual(steps, ["bun install", "bun run desktop:build"]);
  const jobs = workflow.split(/^  (?=build-[a-z]+:$)/m).slice(1);
  assert.equal(jobs.length, 2, "expected the mac and the Windows build job");
  for (const job of jobs) {
    let from = 0;
    for (const step of steps) {
      const found = job.slice(from).search(new RegExp(`^\\s*(?:run: )?${step}(?:\\s+#.*)?$`, "m"));
      assert.ok(found >= 0, `the desktop job ${job.split(":")[0]} no longer runs \`${step}\` (after the previous step)`);
      from += found + step.length;
    }
  }
});

test("a machine without Bun is told so before anything is run", () => {
  const ran = [];
  assert.throws(
    () => buildBundle({ src: "/build/src", bun: null, run: () => ran.push(1) }),
    bundleError(/bun was not found on PATH.*Install Bun/s),
  );
  assert.deepEqual(ran, []);

  // The whole job checks for Bun first, so nothing is fetched on a machine that cannot build.
  const up = fakeUpstream();
  const dir = folder("build");
  assert.throws(
    () => upstreamBundle({ sha: up.first, dir, remote: up.repo, bun: null, run: () => ran.push(1) }),
    bundleError(/bun was not found on PATH/),
  );
  assert.equal(existsSync(join(dir, "src")), false);
  assert.deepEqual(ran, []);

  const bin = folder("bin");
  writeFileSync(join(bin, "bun"), "");
  assert.equal(findOnPath("bun", [folder("empty"), "", bin].join(delimiter), "linux"), join(bin, "bun"));
  assert.equal(findOnPath("bun", folder("empty"), "linux"), null);
});

test("a finished build leaves the bundle of that commit and a built-from note; nothing else marks it complete", () => {
  const up = fakeUpstream();
  const dir = folder("build");
  const build = fakeBuild();
  const done = upstreamBundle({ sha: up.first, dir, remote: up.repo, bun: "bun", run: build.run });
  assert.equal(done.built, true);
  assert.equal(done.dist, join(dir, "src", "dist"));
  assert.deepEqual(build.ran, [["bun", "install"], ["bun", "run", "desktop:build"]]);
  assert.equal(readFileSync(join(done.dist, "index.html"), "utf8"), "<p>first\n</p>", "the bundle must come from the given commit");
  assert.equal(readFileSync(join(dir, MARKER_NAME), "utf8"), `built-from: ${up.first}\n`);
  assert.equal(markerText(up.first), `built-from: ${up.first}\n`);
  assert.equal(MARKER_NAME, "convert-built-from.txt");
});

test("a complete bundle is not built twice, unless asked", () => {
  const up = fakeUpstream();
  const dir = folder("build");
  upstreamBundle({ sha: up.first, dir, remote: up.repo, bun: "bun", run: fakeBuild().run });

  const again = fakeBuild();
  assert.equal(upstreamBundle({ sha: up.first, dir, remote: up.repo, bun: "bun", run: again.run }).built, false);
  assert.deepEqual(again.ran, []);

  const forced = fakeBuild();
  assert.equal(upstreamBundle({ sha: up.first, dir, remote: up.repo, rebuild: true, bun: "bun", run: forced.run }).built, true);
  assert.equal(forced.ran.length, 2);
});

test("a note for another commit, or a bundle that lost a file, does not count as complete", () => {
  const up = fakeUpstream();
  const dir = folder("build");
  upstreamBundle({ sha: up.first, dir, remote: up.repo, bun: "bun", run: fakeBuild().run });

  writeFileSync(join(dir, MARKER_NAME), markerText(up.second));
  const afterWrongNote = fakeBuild();
  assert.equal(upstreamBundle({ sha: up.first, dir, remote: up.repo, bun: "bun", run: afterWrongNote.run }).built, true);
  assert.equal(readFileSync(join(dir, MARKER_NAME), "utf8"), markerText(up.first));

  rmSync(join(dir, "src", "dist", "cache.json"));
  const afterLoss = fakeBuild();
  assert.equal(upstreamBundle({ sha: up.first, dir, remote: up.repo, bun: "bun", run: afterLoss.run }).built, true);
  assert.equal(afterLoss.ran.length, 2);
});

test("a build that fails or leaves an incomplete bundle writes no note, and removes an earlier one", () => {
  const up = fakeUpstream();
  const cases = [
    [fakeBuild({ fail: true }), /the stand-in build failed/],
    [fakeBuild({ index: false }), /left no .*index\.html/],
    [fakeBuild({ cache: null }), /left no .*cache\.json/],
    [fakeBuild({ cache: "not json" }), /cache\.json is not valid JSON/],
    [fakeBuild({ cache: "[]" }), /not a filled list of formats/],
    [fakeBuild({ cache: '{"a":1}' }), /not a filled list of formats/],
  ];
  for (const [build, message] of cases) {
    const dir = folder("build");
    assert.throws(() => upstreamBundle({ sha: up.first, dir, remote: up.repo, bun: "bun", run: build.run }), bundleError(message));
    assert.equal(existsSync(join(dir, MARKER_NAME)), false, `a note was written although: ${message}`);
  }

  // A good build, then a forced rebuild that fails: the old note and the old bundle must both go.
  const dir = folder("build");
  upstreamBundle({ sha: up.first, dir, remote: up.repo, bun: "bun", run: fakeBuild().run });
  assert.throws(
    () => upstreamBundle({ sha: up.first, dir, remote: up.repo, rebuild: true, bun: "bun", run: fakeBuild({ fail: true }).run }),
    bundleError(/the stand-in build failed/),
  );
  assert.equal(existsSync(join(dir, MARKER_NAME)), false);
  assert.equal(existsSync(join(dir, "src", "dist")), false, "a stale bundle must not survive a failed rebuild");
});

test("a failure to fetch the commit never reaches the build", () => {
  const up = fakeUpstream();
  const dir = folder("build");
  const build = fakeBuild();
  assert.throws(() => upstreamBundle({ sha: SHA, dir, remote: up.repo, bun: "bun", run: build.run }), bundleError(/could not be fetched/));
  assert.deepEqual(build.ran, []);
  assert.equal(existsSync(join(dir, MARKER_NAME)), false);
});

test("the command line reports a problem in one line and exits 1; without a sha it builds nothing", () => {
  const lines = [];
  const print = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  assert.equal(main([], {}, print), 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[upstream-bundle\] error: No upstream commit was given/);
  assert.equal(main(["--sha", "abc123"], {}, print), 1);
  assert.match(lines[1], /not a full commit sha/);
});

test("the script still runs when its folder is reached through a link", () => {
  // Gradle starts the script by path. Were that path compared unresolved with the module's
  // real location, a linked checkout would build nothing and still report success.
  const real = folder("tools");
  const script = join(real, "script.mjs");
  writeFileSync(script, "");
  writeFileSync(join(real, "other.mjs"), "");
  const link = join(folder("links"), "tools");
  symlinkSync(real, link, "junction");
  const url = pathToFileURL(realpathSync(script)).href;
  assert.equal(startedAsScript(script, url), true);
  assert.equal(startedAsScript(join(link, "script.mjs"), url), true, "the same file through a linked folder");
  assert.equal(startedAsScript(join(link, "other.mjs"), url), false);
  assert.equal(startedAsScript(join(real, "missing.mjs"), url), false);
  assert.equal(startedAsScript(undefined, url), false);
});

// --- wiring a script cannot show: read from the Gradle file ----------------------------------

test("Gradle takes the commit from -PupstreamSha or UPSTREAM_SHA, has no default, and stops without one", () => {
  assert.match(gradle, /findProperty\("upstreamSha"\)\?\.toString\(\) \?: System\.getenv\("UPSTREAM_SHA"\) \?: ""/);
  assert.match(gradle, /Regex\("\[0-9a-f\]\{40\}"\)\.matches\(upstreamSha\)/);
  assert.doesNotMatch(gradle, /[0-9a-f]{40}/, "no commit may be written into the Gradle file");
  const task = gradle.slice(gradle.indexOf("val buildWebBundle"), gradle.indexOf("val copyDistToAssets"));
  const stop = task.indexOf("if (!upstreamShaGiven)");
  assert.ok(stop >= 0 && stop < task.indexOf("project.exec"), "the missing-sha check must come before anything is run");
  assert.match(task, /-PupstreamSha=<sha>/);
  assert.match(task, /built-from:/);
});

test("Gradle builds the bundle with upstream-bundle.mjs and packages only what that script marked complete", () => {
  const task = gradle.slice(gradle.indexOf("val buildWebBundle"), gradle.indexOf("val copyDistToAssets"));
  assert.match(task, /rootProject\.file\("tools\/upstream-bundle\.mjs"\)/);
  assert.match(task, /"--sha", upstreamSha,/);
  assert.match(task, /"--dir", upstreamDir\.absolutePath,/);
  assert.match(task, /if \(result\.exitValue != 0\) \{\s*error\(/);

  assert.match(gradle, /val distDir = File\(upstreamDir, "src\/dist"\)/);
  assert.match(gradle, new RegExp(`val builtFromFile = File\\(upstreamDir, "${MARKER_NAME}"\\)`));
  assert.match(gradle, /rootProject\.file\("build\/upstream"\)/, "the build-only folder must stay under android/build/, which is ignored");
  const copy = gradle.slice(gradle.indexOf("val copyDistToAssets"), gradle.indexOf("\nandroid {"));
  assert.match(copy, /dependsOn\(buildWebBundle\)/);
  assert.match(copy, /require\(builtFromFile\.isFile/);
  // MainActivity serves assets/convert/ and nothing above it, so the note is not reachable by the page.
  assert.match(copy, /from\(distDir\) \{ into\("convert"\) \}/);
  assert.match(copy, /from\(builtFromFile\)/);

  // The fork's own tree is not what gets bundled any more.
  assert.doesNotMatch(gradle, /rootProject\.file\("\.\."\)/);
  assert.doesNotMatch(gradle, /\bnpm\b/);
});

test("the version label is still the desktop release tag", () => {
  const name = gradle.match(/^val appVersionName = "build-(\d{8})"$/m);
  assert.ok(name, 'appVersionName must be "build-YYYYMMDD", the desktop tag');
  const code = gradle.match(/^val appVersionCode = (\d+)$/m);
  assert.ok(code, "appVersionCode was not found");
  assert.equal(code[1], name[1], "versionCode must be the same date as the tag");
  assert.match(gradle, /versionName = appVersionName/);
  assert.match(gradle, /versionCode = appVersionCode/);
});
