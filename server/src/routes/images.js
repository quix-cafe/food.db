import path from 'node:path';
import { Router } from 'express';
import { query } from '../db.js';
import { uploadDir, removeFiles, thumbDir } from '../images.js';
import { thumbFor } from '../thumbs.js';
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

/** A small JPEG of the image for lists and galleries; the full image when it can't have one. */
router.get('/:id/thumb', async (req, res) => {
  const { rows } = await query('SELECT filename, mime FROM images WHERE id = $1', [uuid(req.params.id, 'id')]);
  if (!rows[0]) throw notFound('Image');
  const thumb = await thumbFor(rows[0]);
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.type(thumb ? 'image/jpeg' : rows[0].mime);
  res.sendFile(thumb ? path.basename(thumb) : rows[0].filename, { root: thumb ? thumbDir() : uploadDir() }, (err) => {
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
