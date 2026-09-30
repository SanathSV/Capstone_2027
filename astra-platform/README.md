# Astra website

This directory contains the Next.js website, its server/API routes, and its build configuration.
The browser extension, Python bot authentication tool, SQL setup scripts, captured
requests, and detailed project documentation live in [../astra-extras](../astra-extras/).
The meeting bot remains in [../BOT-CONTAINER](../BOT-CONTAINER/).

## Local development

Run from this directory:

```sh
npm ci
# Copy .env.example to .env.local and fill in your values.
npm run dev
```

Local bot sign-in requires the sibling `astra-extras/bot-auth` directory and its
Python dependencies. Set `ASTRA_ALLOW_LOCAL_BOT_AUTH=1` only for `npm run dev`.
Captured requests are optional: `ASTRA_DUMP_REQUESTS=1` enables captures during
development, written to `../astra-extras/_sent_data_extension`. Both features are
disabled in production, even if their environment flags are set.

## Build the website independently

From the `Capstone_2027` repository root:

```sh
cd astra-platform
npm ci
npm run build
npm start
```

Use Node.js 22 and configure `.env.local` as described above. `npm ci` is needed
on a fresh checkout or after dependency changes. `npm run build` produces the
website in `.next`; `npm start` serves that production build on port 3000.
Neither command requires the extension, Python, `astra-extras`, or `BOT-CONTAINER`.
The running website still needs its Supabase environment variables and database.

You can also build without changing directories, from the repository root:

```sh
npm --prefix astra-platform run build
```

For Cloudflare deployment, use `npm run build:cloudflare` instead: it also packages
the Next.js build as a Worker. The settings below use that command.

## Cloudflare Workers

The repository root is `Capstone_2027`. In the Cloudflare Git build form use:

| Setting | Value |
| --- | --- |
| Path / root directory | `astra-platform` |
| Build command | `npm run build:cloudflare` |
| Deploy command | `npm run deploy:cloudflare` |
| Preview version command | `npm run upload:cloudflare` |

Cloudflare installs npm dependencies from the lockfile before building. If automatic
installation is disabled, use `npm ci && npm run build:cloudflare` instead.
Use Node.js 22 (also specified in `.node-version`).
Commit the folder moves, configuration, package.json, and package-lock.json before
deploying from Git. No deployment is performed by the build command.

The configured Worker name is `capstone-2027`. If changing it, update both `name`
and the self-reference service name in `wrangler.jsonc`.

Build variables:

- `NEXT_PUBLIC_SUPABASE_URL`: bare Supabase project URL.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: public anon/publishable key.

Worker runtime variables/secrets (Settings > Variables and Secrets):

- The same two Supabase public variables.
- `SUPABASE_SERVICE_ROLE_KEY`: secret, server-side only.
- `ASTRA_ENCRYPTION_KEY`: secret; preserve the existing key so saved integrations decrypt.
- `GEMINI_API_KEY`: secret, required for AI chat.
- Optional `GEMINI_MODEL`, `GEMINI_BASE_URL`, `GEMINI_TIMEOUT_MS`, `GEMINI_MAX_OUTPUT_TOKENS`.

The Cloudflare build removes local `.env` values from OpenNext's generated runtime
module. Supply runtime values through Worker bindings (or an ignored `.dev.vars`
file for local Worker preview), including the two public Supabase values above.

Add your deployed `/auth/callback` URL to Supabase's allowed redirect URLs and
configure the deployed site URL in Supabase Auth. Never commit `.env.local`.

Commands from this directory:

```sh
npm run build                  # Standard Next.js production build
npm run build:cloudflare       # Build the Worker and static assets with OpenNext
npm run preview:cloudflare     # Run the already-built Worker locally
npm run deploy:cloudflare      # Publish the already-built Worker
```

OpenNext and Wrangler are pinned for this existing Next.js 14 application.
Do not independently upgrade OpenNext to a release that requires Next.js 15/16;
upgrade and test the framework and adapter together. Cloudflare builds on Linux;
OpenNext recommends WSL/Linux when native Windows builds encounter platform issues.
The dependency audit reports security advisories, including critical advisories in
Next.js and a transitive build dependency. A framework/toolchain upgrade remains
necessary before treating this as a production-hardened deployment.

The hosted website cannot perform desktop Google sign-in or run the meeting bot.
Those tools stay separate. `/api/bot/summon` remains the existing acknowledgment
endpoint; this cleanup does not implement container launching.

References: [OpenNext setup](https://opennext.js.org/cloudflare/get-started)
and [platform support](https://opennext.js.org/cloudflare).
