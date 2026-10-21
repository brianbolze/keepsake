import { build } from "esbuild";

// Chrome requires JavaScript. Keep its generated files under extension/dist so
// the extension can still be loaded unpacked from extension/.
await build({
  entryPoints: [
    "extension/background.ts",
    "extension/capture.ts",
    "extension/popup.ts",
  ],
  outdir: "extension/dist",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
});
