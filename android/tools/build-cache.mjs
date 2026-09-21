// Node-compatible equivalent of the repo's `buildCache.js` (which is Bun-only).
//
// `buildCache.js` uses Bun.serve / Bun.file / Bun.write, so `bun run cache:build` needs Bun
// installed. The Android wrapper's build runs on plain Node, so this script does the same job
// with node:http and node:fs: serve dist/ exactly the way the app is served in production,
// open it in Puppeteer's Chrome, wait for the app to finish probing every handler, and write
// the resulting format cache to dist/cache.json.
//
// Without that file the app rebuilds its whole format list on every cold start, which costs
// the user tens of seconds behind "Loading formats…" before anything is clickable.
//
// Usage: node android/tools/build-cache.mjs [distDir] [outputPath] [--minify]
// Env:   PUPPETEER_EXECUTABLE_PATH — use a specific Chrome instead of Puppeteer's own.

import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const args = process.argv.slice(2).filter((a) => a !== "--minify");
const minify = process.argv.includes("--minify");
const distDir = resolve(repoRoot, args[0] ?? "dist");
const outputPath = resolve(repoRoot, args[1] ?? join(distDir, "cache.json"));

// The app is served under /convert/, matching Vite's `base` and the Android asset loader.
const BASE = "/convert/";
const TIMEOUT_MS = 15 * 60 * 1000;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".tar": "application/x-tar",
  ".data": "application/octet-stream",
  ".sf2": "application/octet-stream",
};

// `npm install --ignore-scripts` skips Puppeteer's browser download, and a half-extracted
// download in its cache is worse than none, so fall back to a Chrome already on the machine
// before asking the user to fetch one.
const SYSTEM_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

async function launchBrowser(puppeteer) {
  const candidates = [];
  if (process.env.PUPPETEER_EXECUTABLE_PATH) candidates.push(process.env.PUPPETEER_EXECUTABLE_PATH);
  try {
    candidates.push(puppeteer.executablePath());
  } catch {
    // Puppeteer has no browser of its own registered; the system list below may still work.
  }
  candidates.push(...SYSTEM_BROWSERS);

  const failures = [];
  for (const executablePath of candidates) {
    if (!existsSync(executablePath)) continue;
    try {
      const browser = await puppeteer.launch({
        headless: true,
        executablePath,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      console.log(`Using ${executablePath}.`);
      return browser;
    } catch (e) {
      // A half-extracted download in Puppeteer's cache exists but cannot run; keep looking.
      failures.push(`${executablePath}: ${String(e).split("\n")[0]}`);
    }
  }
  throw new Error(
    "Could not launch a browser to build the format cache. Run " +
      "`npx puppeteer browsers install chrome`, or set PUPPETEER_EXECUTABLE_PATH to a " +
      "working Chrome/Chromium binary.\nTried:\n  " +
      (failures.join("\n  ") || "(no candidate found on this machine)"),
  );
}

async function main() {
  if (!(await stat(distDir).catch(() => null))?.isDirectory()) {
    throw new Error(
      `dist/ not found at ${distDir} — build it first:\n` +
        "  npx tsc && IS_DESKTOP=true npx vite build",
    );
  }

  // Remove any previous cache so the app is forced to regenerate it rather than read its own
  // stale output back.
  await rm(outputPath, { force: true });

  const server = createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    } catch {
      res.writeHead(400).end("Bad Request");
      return;
    }
    if (pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length);
    if (pathname === "" || pathname === "/") pathname = "index.html";

    // Matches the real server: the cache does not exist yet while we are building it.
    if (pathname === "cache.json") {
      res.writeHead(204).end();
      return;
    }

    const filePath = resolve(distDir, pathname.replace(/^\/+/, ""));
    if (filePath !== distDir && !filePath.startsWith(distDir + sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404).end("Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": info.size,
      // The desktop and Android hosts both send these; keep the cache build faithful to them.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    createReadStream(filePath).pipe(res);
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();

  const { default: puppeteer } = await import("puppeteer").catch(() => {
    throw new Error("puppeteer is not installed — run `npm install` in the repo root first.");
  });

  const browser = await launchBrowser(puppeteer);

  try {
    const page = await browser.newPage();
    const built = new Promise((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`Timed out after ${TIMEOUT_MS / 1000}s waiting for the format list.`)),
        TIMEOUT_MS,
      );
      page.on("console", (msg) => {
        const text = msg.text();
        if (msg.type() === "error") console.error(text);
        if (text === "Built initial format list.") {
          clearTimeout(timer);
          done();
        }
      });
      page.on("pageerror", (e) => console.error(String(e)));
    });

    const started = Date.now();
    await Promise.all([built, page.goto(`http://127.0.0.1:${port}${BASE}index.html`)]);
    console.log(`Format list built in ${((Date.now() - started) / 1000).toFixed(1)}s.`);

    const cacheJSON = await page.evaluate(
      (shouldMinify) =>
        shouldMinify
          ? JSON.stringify(JSON.parse(window.printSupportedFormatCache()))
          : window.printSupportedFormatCache(),
      minify,
    );
    if (!cacheJSON) throw new Error("printSupportedFormatCache() returned nothing.");
    // The app does `new Map(cacheJSON)`, so the file must be an array of entries.
    const parsed = JSON.parse(cacheJSON);
    if (!Array.isArray(parsed)) throw new Error("format cache is not an array of entries.");

    await writeFile(outputPath, cacheJSON, "utf-8");
    const written = await readFile(outputPath, "utf-8");
    console.log(`Wrote ${outputPath} (${parsed.length} entries, ${written.length} bytes).`);
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

await main();
