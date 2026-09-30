import { access, writeFile } from "node:fs/promises";

// OpenNext 1.14 copies .env.local into this generated module. Production secrets
// must come from Worker bindings instead of becoming part of an uploaded bundle.
// Public NEXT_PUBLIC_* values are already compiled into the browser code by Next.
const target = new URL("../.open-next/cloudflare/next-env.mjs", import.meta.url);
await access(target); // Fail if no Cloudflare build exists; do not create a partial one.
await writeFile(
  target,
  "// Runtime values are supplied through Cloudflare variables and secrets.\n" +
    "export const production = {};\n" +
    "export const development = {};\n" +
    "export const test = {};\n",
);
console.log("Cloudflare bundle uses runtime bindings; local environment values excluded.");
