// Checks the Android wrapper's own code without a device, an emulator or Gradle.
//
// The wrapper's save path is half Kotlin, half a script MainActivity injects into the page.
// This runs that script exactly as it appears in MainActivity.kt against a fake page and a
// fake bridge, and reads the manifest and the activity for the wiring a script cannot show.
//
// Usage: node android/tools/wrapper.test.mjs [path to an android/ directory]
// Needs only Node 20+; nothing is installed, opened or contacted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const androidDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const main = join(androidDir, "app", "src", "main");
const activity = readFileSync(join(main, "java", "com", "jamesbreedon", "convert", "MainActivity.kt"), "utf8");
const manifest = readFileSync(join(main, "AndroidManifest.xml"), "utf8");

const CHUNK = 4; // tiny, so a few bytes already take several chunks

/** The injected script, lifted out of the Kotlin raw string it is written in. */
function interceptScript() {
  const found = activity.match(/DOWNLOAD_INTERCEPT_SCRIPT = """\n([\s\S]*?)\n\s*"""\.trimIndent\(\)/);
  assert.ok(found, "DOWNLOAD_INTERCEPT_SCRIPT was not found in MainActivity.kt");
  const script = found[1].replaceAll("$SAVE_CHUNK_BYTES", String(CHUNK));
  assert.ok(!script.includes("$"), "the script still holds a Kotlin string template");
  return script;
}

/**
 * A page with the script installed. `bridge` overrides the fake AndroidDownloader's methods;
 * every bridge call is recorded, and `finished` resolves once the save has ended either way.
 */
function page({ bridge = {}, fetch = () => Promise.reject(new Error("no such blob")) } = {}) {
  const calls = [];
  const bytes = [];
  let finish;
  const finished = new Promise((done) => { finish = done; });
  const defaults = {
    saveBegin: () => "1",
    saveChunk: (id, base64) => { bytes.push(...Buffer.from(base64, "base64")); return true; },
    saveEnd: () => true,
    saveAbort: () => {},
    saveFailed: () => {},
  };
  const fake = {};
  for (const name of Object.keys(defaults)) {
    fake[name] = (...args) => {
      calls.push([name, ...args]);
      const result = (bridge[name] ?? defaults[name])(...args);
      if (name !== "saveBegin" && !(name === "saveChunk" && result)) finish();
      return result;
    };
  }

  let urls = 0;
  const fakeUrl = {
    createObjectURL: () => `blob:https://appassets.androidplatform.net/${++urls}`,
    revokeObjectURL: () => {},
  };
  let nativeClicks = 0;
  class Anchor {
    constructor(href, download) { this.href = href; this.download = download; }
    hasAttribute(name) { return name === "download" && this.download !== undefined; }
    getAttribute(name) { return name === "download" ? this.download : null; }
    click() { nativeClicks++; }
  }
  const window = { AndroidDownloader: fake };
  const quiet = { error() {}, log() {}, warn() {} };
  new Function("window", "URL", "HTMLAnchorElement", "fetch", "console", interceptScript())(
    window, fakeUrl, Anchor, fetch, quiet,
  );

  const names = () => calls.map((call) => call[0]);
  const settled = () => new Promise((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`the save never ended; bridge calls so far: ${names().join(", ") || "none"}`)), 2000,
    );
    finished.then(() => { clearTimeout(timer); done(); });
  });
  return { URL: fakeUrl, Anchor, calls, names, bytes, settled, nativeClicks: () => nativeClicks };
}

test("a result is streamed to the bridge in chunks, in order, and then closed", async () => {
  const p = page();
  const data = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 255]);
  const url = p.URL.createObjectURL(new Blob([data], { type: "video/mp4" }));
  new p.Anchor(url, "out.mp4").click();
  await p.settled();
  assert.deepEqual(p.calls[0], ["saveBegin", "out.mp4", "video/mp4"]);
  assert.deepEqual(p.names(), ["saveBegin", "saveChunk", "saveChunk", "saveChunk", "saveEnd"]);
  assert.deepEqual(Buffer.from(p.bytes), data);
  assert.equal(p.nativeClicks(), 0, "the WebView must not also try to follow the blob: link");
});

test("the user is told when the destination file cannot be created", async () => {
  const p = page({ bridge: { saveBegin: () => "" } });
  const url = p.URL.createObjectURL(new Blob(["abc"]));
  new p.Anchor(url, "report.pdf").click();
  await p.settled();
  assert.deepEqual(p.calls, [
    ["saveBegin", "report.pdf", "application/octet-stream"],
    ["saveFailed", "report.pdf"],
  ]);
});

test("the user is told when the result cannot be read back at all", async () => {
  const p = page(); // its fetch rejects, and this blob: URL was never seen being created
  new p.Anchor("blob:https://appassets.androidplatform.net/unknown", "lost.png").click();
  await p.settled();
  assert.deepEqual(p.calls, [["saveFailed", "lost.png"]]);
});

test("a failed write stops the save without closing the file as if it had worked", async () => {
  const p = page({ bridge: { saveChunk: () => false } });
  const url = p.URL.createObjectURL(new Blob([Buffer.alloc(10)]));
  new p.Anchor(url, "big.bin").click();
  await p.settled();
  // The bridge itself aborts and tells the user when a write fails; the page just stops.
  assert.deepEqual(p.names(), ["saveBegin", "saveChunk"]);
});

test("a result that cannot be read part-way is aborted, not left half-written", async () => {
  const p = page();
  const blob = new Blob([Buffer.alloc(10)]);
  let reads = 0;
  const broken = {
    size: blob.size,
    type: "",
    slice: (from, to) => (++reads === 2
      ? { arrayBuffer: () => Promise.reject(new Error("read failed")) }
      : blob.slice(from, to)),
  };
  Object.setPrototypeOf(broken, Blob.prototype);
  const url = p.URL.createObjectURL(broken);
  new p.Anchor(url, "half.bin").click();
  await p.settled();
  assert.deepEqual(p.names(), ["saveBegin", "saveChunk", "saveAbort"]);
  assert.deepEqual(p.calls.at(-1), ["saveAbort", "1"]);
});

test("ordinary links are left alone", () => {
  const p = page();
  new p.Anchor("https://example.org/", undefined).click();
  new p.Anchor("https://example.org/file.zip", "file.zip").click();
  assert.equal(p.nativeClicks(), 2);
  assert.deepEqual(p.calls, []);
});

// --- wiring a script cannot show: read from the sources -------------------------------------

/** The body of the first `fun <name>(` in MainActivity.kt, by brace matching. */
function kotlinBody(name) {
  const start = activity.search(new RegExp(`fun ${name}\\(`));
  assert.ok(start >= 0, `fun ${name}( was not found in MainActivity.kt`);
  const open = activity.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < activity.length; i++) {
    if (activity[i] === "{") depth++;
    if (activity[i] === "}" && --depth === 0) return activity.slice(open, i + 1);
  }
  assert.fail(`fun ${name}( has no closing brace`);
}

/** The annotation line(s) directly above `fun <name>(`. */
function annotationsOf(name) {
  const lines = activity.slice(0, activity.search(new RegExp(`fun ${name}\\(`))).split("\n");
  lines.pop(); // the start of the `fun` line itself
  const found = [];
  while (lines.length && lines.at(-1).trim().startsWith("@")) found.push(lines.pop().trim());
  return found;
}

test("the activity is not recreated by split-screen, folding or a keyboard being attached", () => {
  const found = manifest.match(/android:configChanges="([^"]*)"/);
  assert.ok(found, "the activity declares no android:configChanges");
  const handled = found[1].split("|");
  for (const change of [
    "orientation", "screenSize", "smallestScreenSize", "screenLayout", "density",
    "keyboard", "keyboardHidden", "navigation", "uiMode",
  ]) {
    assert.ok(handled.includes(change), `configChanges lacks ${change}: that change would reload the page`);
  }
});

test("the page can reach every bridge method the script calls, and no more", () => {
  for (const name of ["saveBegin", "saveChunk", "saveEnd", "saveAbort", "saveFailed"]) {
    assert.deepEqual(annotationsOf(name), ["@JavascriptInterface"], `${name} must be a @JavascriptInterface`);
  }
  const exposed = activity.match(/^\s*@JavascriptInterface\s*$/gm).length;
  assert.equal(exposed, 5, "a bridge method was added or removed: update this list and the script tests");
  assert.deepEqual(annotationsOf("close"), [], "close() is for onDestroy only, never the page");
});

test("destroying the activity closes the bridge, which deletes every unfinished file", () => {
  assert.match(activity, /webView\.addJavascriptInterface\(downloader, "AndroidDownloader"\)/,
    "the bridge given to the page must be the one onDestroy closes");
  const onDestroy = kotlinBody("onDestroy");
  assert.match(onDestroy, /downloader\.close\(\)/);
  assert.match(onDestroy, /super\.onDestroy\(\)/);
  const close = kotlinBody("close");
  assert.match(close, /closed = true/);
  assert.match(close, /discard\(/);
  const discard = kotlinBody("discard");
  assert.match(discard, /stream\.close\(\)/);
  assert.match(discard, /contentResolver\.delete\(/);
  assert.match(kotlinBody("saveBegin"), /if \(closed\)/, "a destroyed activity must not open new files");
});
