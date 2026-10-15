// Files baked into the standalone binary (scripts/build-binary.js): the built UI, the
// migrations and PGlite's runtime. Null when running from source, where they're read from disk.
// Set by server/src/standalone.js before any other server module loads.
export const embedded = globalThis.__FOODDB_EMBEDDED ?? null;
