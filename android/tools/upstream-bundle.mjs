// Builds the web app the Android APK ships, from upstream at one exact commit.
//
// The desktop builds of this fork are upstream (p2r3/convert) checked out at one commit and
// built with upstream's own build; each desktop release names that commit after "built-from:".
// This script does the same for Android, so an APK and the desktop release of the same tag
// hold the same app:
//
//   1. fetches that one commit of upstream into a build-only folder (its own small git
//      repository under android/build/, which is gitignored: nothing in this fork's checkout
//      is read, changed or built);
//   2. runs upstream's own build there, with the same commands the desktop build runs;
//   3. checks the result is complete and only then writes convert-built-from.txt beside it.
//
// The folder for a commit ends up holding:
//   src/                      upstream at that commit, plus its own (ignored) build output
//   src/dist/                 the bundle that goes into the APK, with cache.json
//   convert-built-from.txt    "built-from: <sha>" — present only when the bundle is complete
//
// Usage: node android/tools/upstream-bundle.mjs --sha <40-character commit>
//          [--dir <folder for this commit>]   default: android/build/upstream/<sha>
//          [--remote <git url>]               default: https://github.com/p2r3/convert.git
//          [--rebuild]                        run upstream's build again even if complete
// Env:   UPSTREAM_SHA — used when --sha is not given.
// Needs: Node 20+, git, and Bun on PATH (upstream's build is written for Bun). Fetching the
//        commit and upstream's build both use the network.

import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM_REMOTE = "https://github.com/p2r3/convert.git";

// Exactly what the desktop build runs after checking upstream out
// (.github/workflows/desktop-build.yml); upstream-bundle.test.mjs fails if the two drift apart.
export const BUILD_COMMANDS = [
  ["bun", "install"],
  ["bun", "run", "desktop:build"],
];

export const MARKER_NAME = "convert-built-from.txt";

/** A failure with a message meant to be read as it is; no stack trace is printed for it. */
export class BundleError extends Error {}

const HELP_SHA =
  'the 40-character commit printed after "built-from:" in the desktop release this APK is to match';

/** The full, lower-case commit sha, or a BundleError that says what is wrong with it. */
export function checkSha(value) {
  const sha = String(value ?? "").trim().toLowerCase();
  if (!sha) {
    throw new BundleError(
      `No upstream commit was given. Pass --sha <sha> (or set UPSTREAM_SHA): ${HELP_SHA}.`,
    );
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new BundleError(
      `"${sha}" is not a full commit sha. Pass ${HELP_SHA}; a shortened sha is refused ` +
        "so the build can never settle on a different commit.",
    );
  }
  return sha;
}

export function markerText(sha) {
  return `built-from: ${sha}\n`;
}

/** Command-line options. `androidDir` is where the default build folder hangs from. */
export function parseArgs(argv, env = {}, androidDir = defaultAndroidDir()) {
  const options = { sha: undefined, dir: undefined, remote: UPSTREAM_REMOTE, rebuild: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rebuild") {
      options.rebuild = true;
    } else if (arg === "--sha" || arg === "--dir" || arg === "--remote") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new BundleError(`${arg} needs a value.`);
      }
      options[arg.slice(2)] = value;
    } else {
      throw new BundleError(`Unknown option ${arg}. Options: --sha, --dir, --remote, --rebuild.`);
    }
  }
  options.sha = checkSha(options.sha ?? env.UPSTREAM_SHA);
  options.dir = resolve(options.dir ?? join(androidDir, "build", "upstream", options.sha));
  return options;
}

function defaultAndroidDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Looks a command up on PATH, so a missing tool is reported with advice. */
export function findOnPath(command, pathValue = process.env.PATH ?? "", platform = process.platform) {
  const names = platform === "win32" ? [`${command}.exe`, `${command}.cmd`, command] : [command];
  for (const folder of pathValue.split(delimiter)) {
    if (!folder) continue;
    for (const name of names) {
      const candidate = join(folder, name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not in this folder
      }
    }
  }
  return null;
}

/**
 * Runs git inside `cwd` and nowhere else. The build folder sits inside this fork's own
 * checkout, so git is told never to look above it for a repository: a build folder that is
 * not (yet) a repository makes git fail instead of acting on the checkout around it.
 */
function git(cwd, args, { allowFail = false } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[name];
  env.GIT_CEILING_DIRECTORIES = dirname(realpathSync(cwd));
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw new BundleError(`git could not be run (${result.error.message}). git is needed to fetch upstream.`);
  }
  const output = { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  if (!output.ok && !allowFail) {
    throw new BundleError(`\`git ${args.join(" ")}\` failed in ${cwd}:\n${output.stderr || output.stdout}`);
  }
  return output;
}

/**
 * Leaves `src` holding upstream at exactly `sha`, with every tracked file as committed.
 * Ignored build output from an earlier run (node_modules and the like) is kept.
 */
export function prepareSource({ sha, src, remote = UPSTREAM_REMOTE, log = () => {} }) {
  sha = checkSha(sha);
  mkdirSync(src, { recursive: true });

  if (!existsSync(join(src, ".git"))) {
    if (readdirSync(src).length > 0) {
      throw new BundleError(
        `${src} holds files but is not a checkout made by this script. Delete that folder and run again.`,
      );
    }
    git(src, ["-c", "init.defaultBranch=build-only", "init", "-q"]);
  }
  const top = git(src, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (!top.ok || realpathSync(top.stdout) !== realpathSync(src)) {
    throw new BundleError(`${src} is not a git repository of its own. Delete that folder and run again.`);
  }

  if (!git(src, ["cat-file", "-e", `${sha}^{commit}`], { allowFail: true }).ok) {
    log(`Fetching ${sha} from ${remote}…`);
    const fetched = git(src, ["fetch", "--quiet", "--no-tags", "--depth", "1", remote, sha], { allowFail: true });
    if (!fetched.ok || !git(src, ["cat-file", "-e", `${sha}^{commit}`], { allowFail: true }).ok) {
      throw new BundleError(
        `Commit ${sha} could not be fetched from ${remote}.\n` +
          `Check that it is ${HELP_SHA}, and that this machine can reach the remote.\n` +
          (fetched.stderr ? `git said: ${fetched.stderr}` : ""),
      );
    }
  }

  // --force puts back any tracked file an earlier, interrupted build left changed.
  git(src, ["checkout", "--quiet", "--force", "--detach", sha]);
  if (existsSync(join(src, ".gitmodules"))) {
    log("Fetching upstream's submodules…");
    git(src, ["submodule", "update", "--init", "--recursive", "--depth", "1"]);
  }

  const head = git(src, ["rev-parse", "HEAD"]).stdout;
  if (head !== sha) {
    throw new BundleError(`The build folder is at ${head}, not ${sha}. Delete ${src} and run again.`);
  }
  const changed = git(src, ["status", "--porcelain", "--untracked-files=no"]).stdout;
  if (changed) {
    throw new BundleError(`Upstream's files in ${src} differ from commit ${sha}:\n${changed}\nDelete that folder and run again.`);
  }
  return head;
}

function runInherit(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw new BundleError(`${command} could not be run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new BundleError(`\`${[command, ...args].join(" ")}\` failed with exit code ${result.status} in ${cwd}.`);
  }
}

function requireBun(bun) {
  if (!bun) {
    throw new BundleError(
      "bun was not found on PATH. Upstream's build is written for Bun (https://bun.sh), and the " +
        "desktop build runs the same commands with it. Install Bun and run again.",
    );
  }
  return bun;
}

/** Runs upstream's own build in `src`. `run(command, args, cwd)` must throw when a step fails. */
export function buildBundle({ src, bun = findOnPath("bun"), run = runInherit, log = () => {} }) {
  requireBun(bun);
  for (const [tool, ...args] of BUILD_COMMANDS) {
    log(`Running ${tool} ${args.join(" ")} (upstream's own build)…`);
    run(bun, args, src);
  }
}

/** The bundle folder, once it is known to hold a complete build. */
export function checkBundle(src) {
  const dist = join(src, "dist");
  if (!existsSync(join(dist, "index.html"))) {
    throw new BundleError(`Upstream's build left no ${join(dist, "index.html")}.`);
  }
  // Without cache.json the app re-probes every converter on each cold start, which keeps the
  // user waiting behind "Loading formats…"; the app reads it as an array of entries.
  const cachePath = join(dist, "cache.json");
  if (!existsSync(cachePath)) {
    throw new BundleError(`Upstream's build left no ${cachePath} (the precomputed format list).`);
  }
  let cache;
  try {
    cache = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch (e) {
    throw new BundleError(`${cachePath} is not valid JSON (${e.message}).`);
  }
  if (!Array.isArray(cache) || cache.length === 0) {
    throw new BundleError(`${cachePath} is not a filled list of formats; the format list was not built.`);
  }
  return dist;
}

function isComplete(dir, sha) {
  const marker = join(dir, MARKER_NAME);
  const src = join(dir, "src");
  try {
    if (readFileSync(marker, "utf8") !== markerText(sha)) return false;
    checkBundle(src);
    return git(src, ["rev-parse", "HEAD"], { allowFail: true }).stdout === sha;
  } catch {
    return false;
  }
}

/**
 * The whole job: source at `sha`, upstream's build, checks, then the marker. Returns where
 * the bundle is and whether a build was needed.
 */
export function upstreamBundle({
  sha, dir, remote = UPSTREAM_REMOTE, rebuild = false, bun, run, log = () => {},
}) {
  sha = checkSha(sha);
  dir = resolve(dir);
  const src = join(dir, "src");
  const marker = join(dir, MARKER_NAME);
  const result = { sha, src, dist: join(src, "dist"), marker };

  if (!rebuild && isComplete(dir, sha)) {
    log(`The bundle for ${sha} is already complete: ${result.dist}`);
    return { ...result, built: false };
  }

  // A missing tool is reported before anything is fetched.
  bun = requireBun(bun === undefined ? findOnPath("bun") : bun);

  // From here until the end the folder is not a finished build, whatever was there before.
  rmSync(marker, { force: true });
  prepareSource({ sha, src, remote, log });
  rmSync(result.dist, { recursive: true, force: true });

  const options = { src, bun, log };
  if (run !== undefined) options.run = run;
  buildBundle(options);

  checkBundle(src);
  const head = git(src, ["rev-parse", "HEAD"]).stdout;
  if (head !== sha) {
    throw new BundleError(`The build folder moved to ${head} during the build; expected ${sha}.`);
  }
  writeFileSync(marker, markerText(sha));
  log(`Bundle built from upstream ${sha}: ${result.dist}`);
  return { ...result, built: true };
}

/** The command line. Returns the process exit code. */
export function main(argv, env = process.env, print = console) {
  try {
    const options = parseArgs(argv, env);
    upstreamBundle({ ...options, log: (line) => print.log(`[upstream-bundle] ${line}`) });
    return 0;
  } catch (e) {
    if (!(e instanceof BundleError)) throw e;
    print.error(`[upstream-bundle] error: ${e.message}`);
    return 1;
  }
}

/**
 * Whether `scriptPath` (what node was started with) is the file at `moduleUrl`. Both are
 * followed through symbolic links first: node names a module by its real path, so a plain
 * comparison would say "no" for a checkout reached through a linked folder, and the script
 * would then do nothing and still exit 0.
 */
export function startedAsScript(scriptPath, moduleUrl = import.meta.url) {
  if (!scriptPath) return false;
  try {
    return realpathSync(scriptPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (startedAsScript(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
