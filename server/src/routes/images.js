import { Router } from 'express';
import { query } from '../db.js';
import { uploadDir, removeFiles } from '../images.js';
import { notFound, uuid } from '../validate.js';

const router = Router();

router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT filename, mime FROM images WHERE id = $1', [uuid(req.params.id, 'id')]);
  if (!rows[0]) throw notFound('Image');
  // Files are never rewritten (new uploads get new ids), so they can be cached forever.
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.type(rows[0].mime);
  // `root` keeps send's dotfile check to the file name; the binary's data dir is under ~/.local on Linux.
  res.sendFile(rows[0].filename, { root: uploadDir() }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Image file is missing from storage' });
  });
});

router.delete('/:id', async (req, res) => {
  const { rows } = await query('DELETE FROM images WHERE id = $1 RETURNING filename', [uuid(req.params.id, 'id')]);
  if (!rows[0]) throw notFound('Image');
  await removeFiles([rows[0].filename]);
  res.status(204).end();
});

export default router;
