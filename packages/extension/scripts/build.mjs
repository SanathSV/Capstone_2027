// Placeholder build: copies manifest.json, src/ and icons/ into dist/ for unpacked loading.
// Swap for a real bundler (vite-plugin-web-extension / esbuild) when the source grows.
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, "src"), dist, { recursive: true });
await cp(resolve(root, "icons"), resolve(dist, "icons"), { recursive: true });
await cp(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));

console.log("Extension built to dist/ — load it via chrome://extensions (Developer mode).");
