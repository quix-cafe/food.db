import { Router } from 'express';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import multer from 'multer';
import { backupFilename, inspectBackup, listSnapshots, restoreBackup, snapshotPath, summarizeCurrent, writeBackup } from '../backup.js';
import { badRequest, notFound, uuid } from '../validate.js';

const router = Router();

const upload = multer({ dest: tmpdir(), limits: { fileSize: 4 * 1024 ** 3, files: 1 } }).single('file');

// What a backup would contain right now, plus the automatic pre-restore snapshots.
router.get('/summary', async (_req, res) => {
  res.json({ ...(await summarizeCurrent()), snapshots: await listSnapshots() });
});

// Download a full backup.
router.get('/', async (_req, res) => {
  res.set({
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${backupFilename()}"`,
    'Cache-Control': 'no-store',
  });
  await writeBackup(res);
});

// Step 1 of a restore: upload and check the archive. Nothing changes yet.
router.post('/inspect', upload, async (req, res) => {
  if (!req.file) throw badRequest('Choose a backup file to upload');
  try {
    res.json(await inspectBackup(req.file.path));
  } finally {
    await rm(req.file.path, { force: true });
  }
});

// Step 2: replace everything with the inspected backup.
router.post('/restore', async (req, res) => {
  res.json(await restoreBackup(uuid(req.body?.token, 'token')));
});

router.get('/snapshots/:name', async (req, res) => {
  const file = snapshotPath(req.params.name);
  if (!file) throw notFound('Snapshot');
  // `root` keeps send's dotfile check to the file name; the binary's data dir is under ~/.local on Linux.
  res.download(path.basename(file), req.params.name, { root: path.dirname(file) }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Snapshot not found' });
  });
});

export default router;
