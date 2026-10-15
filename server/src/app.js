import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CalcError } from '@kitchen/shared';
import ingredients from './routes/ingredients.js';
import recipes from './routes/recipes.js';
import events from './routes/events.js';
import search from './routes/search.js';
import receipts from './routes/receipts.js';
import images from './routes/images.js';
import backup from './routes/backup.js';
import multer from 'multer';
import { HttpError } from './validate.js';
import { query } from './db.js';

const clientDist = fileURLToPath(new URL('../../client/dist/', import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, error: 'Database unreachable' });
    }
  });
  app.use('/api/ingredients', ingredients);
  app.use('/api/recipes', recipes);
  app.use('/api/events', events);
  app.use('/api/search', search);
  app.use('/api/receipts', receipts);
  app.use('/api/images', images);
  app.use('/api/backup', backup);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // In production the built SPA is served from here; in dev Vite proxies /api instead.
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('/{*path}', (_req, res) => res.sendFile(clientDist + 'index.html'));
  }

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof CalcError) return res.status(400).json({ error: err.message });
    if (err instanceof multer.MulterError) {
      const message = { LIMIT_FILE_SIZE: err.field === 'file' ? 'Backup files can be at most 4 GB' : 'Each image must be 15 MB or smaller', LIMIT_FILE_COUNT: 'Upload at most 20 images at a time' }[err.code] ?? err.message;
      return res.status(400).json({ error: message });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Check the server log for details.' });
  });
  return app;
}
