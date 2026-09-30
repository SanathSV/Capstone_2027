# =============================================================================
# Astra BOT-CONTAINER
#
# Base image: Microsoft's own Playwright image, which already carries Chromium
# and — the part people lose an afternoon to — the ~90 shared libraries a
# headless Chrome needs on Debian (libnss3, libatk, libgbm, the fontconfig
# stack). Building on plain `node:20-slim` produces a browser that exits
# immediately with a missing-library error that names only the first one.
#
# THE VERSION IN THIS TAG MUST MATCH `playwright` IN package.json.
# Playwright refuses to drive a browser build it was not shipped with, and the
# error ("Executable doesn't exist at /ms-playwright/chromium-1140/…") reads
# like a broken image rather than a version skew.
# =============================================================================
FROM mcr.microsoft.com/playwright:v1.48.2-jammy

ENV NODE_ENV=production \
    # The base image installs browsers here, as root, at image build time.
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # Do not re-download Chromium during `npm ci`: it is already in the image,
    # and the download is ~150 MB of layer for no benefit.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HOST=0.0.0.0 \
    PORT=3001

WORKDIR /app

# Dependencies first, in their own layer: application code changes on every
# build, package-lock.json does not, so this layer stays cached.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY sql ./sql
# The diagnostic scripts travel with the image so a deployed container can be
# checked in place: `docker compose exec bot-container node scripts/smoke.js`.
# They are a few kilobytes and pull in no extra dependencies.
COPY scripts ./scripts

# Debug screenshots and (optionally) payload dumps land here. Declared as a
# volume so a container restart does not take them with it.
RUN mkdir -p /app/data && chown -R pwuser:pwuser /app
VOLUME ["/app/data"]

# The Playwright image ships this unprivileged user. Chrome's own sandbox is
# already disabled inside the container (--no-sandbox), so running as root would
# buy nothing and give a compromised page a root shell.
USER pwuser

EXPOSE 3001

# The bot must be able to leave its call cleanly on shutdown — flush the caption
# buffer, drain the transcript queue, write the summary. `node` as PID 1 with an
# explicit SIGTERM handler (see the bottom of src/server.js) is what makes that
# possible; a shell-form CMD would swallow the signal.
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
