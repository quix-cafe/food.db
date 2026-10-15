// Entry point of the standalone binary (scripts/build-binary.js): the API, the UI and an
// embedded PGlite database in one executable. Data lives in a per-user folder, no Docker or
// Postgres needed.

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { files, version } from './embedded.gen.js';

const HELP = `food.db ${version}: kitchen cost & recipe manager

Usage: food.db [options]

  --port <n>        Port to serve on (default 3000, or $PORT)
  --data-dir <dir>  Where the database, photos and backups are kept
                    (default ${defaultDataDir()})
  --no-open         Don't open the browser
  -v, --version     Print the version
  -h, --help        Show this help
`;

function defaultDataDir() {
  if (process.env.FOODDB_DATA_DIR) return process.env.FOODDB_DATA_DIR;
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'food.db');
  return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'food.db');
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      port: { type: 'string' },
      'data-dir': { type: 'string' },
      'no-open': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  console.error(`${err.message}\n\n${HELP}`);
  process.exit(2);
}
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.version) {
  console.log(version);
  process.exit(0);
}

const port = Number(args.port ?? process.env.PORT ?? 3000);
const url = `http://localhost:${port}`;
const open = !args['no-open'];

// Already running (the database can only be open in one process): just show it.
const running = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
if (running) {
  console.log(`food.db is already running at ${url}`);
  if (open) openBrowser(url);
  process.exit(0);
}

const dataDir = path.resolve(args['data-dir'] ?? defaultDataDir());
await mkdir(dataDir, { recursive: true });
process.env.DATABASE_URL = `pglite://${path.join(dataDir, 'db')}`;
process.env.UPLOAD_DIR = path.join(dataDir, 'uploads');
process.env.BACKUP_DIR = path.join(dataDir, 'backups');
globalThis.__FOODDB_EMBEDDED = files;

// Loaded only now, so they see the settings above.
const { migrate } = await import('./migrate.js');
const { createApp } = await import('./app.js');
const { pool } = await import('./db.js');

await migrate({ log: () => {} });
const server = createApp().listen(port, '127.0.0.1', () => {
  console.log(`food.db ${version} is running at ${url}\nData: ${dataDir}\nPress Ctrl+C to stop.`);
  if (open) openBrowser(url);
});
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use by another program. Try --port 3001.` : err.message);
  process.exit(1);
});

// Close the database cleanly so nothing is lost mid-write.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
