/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * Where the build lives.
   *
   * Two `next dev` processes started from the same folder share `.next` even on
   * different ports, and they fight over it: each rebuild rewrites the manifests
   * and emits chunks under new hashes, so the *other* server's already-loaded
   * page starts requesting files that no longer exist. It shows up as a burst of
   * 404s for `/_next/static/...` — CSS and JS the page was told to fetch a moment
   * earlier — and nothing in the message points at a second server.
   *
   * So anything that is not your main dev server should run with its own build
   * directory:
   *
   *     ASTRA_DIST_DIR=.next-test npx next dev -p 3999
   *
   * Your `npm run dev` keeps `.next` to itself and is never disturbed.
   */
  distDir: process.env.ASTRA_DIST_DIR || ".next",
};

export default nextConfig;
