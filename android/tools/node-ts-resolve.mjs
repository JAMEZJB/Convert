// Lets Node run this project's TypeScript build scripts unchanged.
//
// The scripts are written for Bun, which resolves an extensionless relative import
// ("./extra-language-extensions") to the neighbouring .ts file. Node's ESM resolver
// requires the extension, so a plain `node scripts/extract-material-icons.ts` fails with
// ERR_MODULE_NOT_FOUND. This hook adds only that one resolution step; Node's own type
// stripping handles the TypeScript itself.
//
// Usage: node --import ./android/tools/node-ts-resolve.mjs <script.ts> [args…]

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXTENSIONS = [".ts", ".tsx", ".mts"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    const hasExtension = /\.[cm]?[jt]sx?$|\.json$|\.node$/.test(specifier);
    if (relative && !hasExtension && context.parentURL) {
      for (const extension of EXTENSIONS) {
        const candidate = new URL(specifier + extension, context.parentURL);
        if (candidate.protocol === "file:" && existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
