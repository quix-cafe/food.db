import path from 'node:path';
import { Router } from 'express';
import { query } from '../db.js';
import { imageJson, uploadDir, removeFiles, thumbDir } from '../images.js';
import { thumbFor } from '../thumbs.js';
import { MAX_SIDE, MIN_SIDE, compressPhoto, cropPhoto, photoSizes, rotatePhoto } from '../compress.js';
import { saveSnapshot } from '../backup.js';
import { HttpError, array, badRequest, notFound, number, uuid } from '../validate.js';

const router = Router();

// Compress photos (Backup page). Every photo's size and dimensions, for estimating a setting.
router.get('/compress', async (_req, res) => {
  res.json({ minSide: MIN_SIDE, maxSide: MAX_SIDE, photos: await photoSizes() });
});

// A copy of everything, photos included, before any are compressed.
router.post('/compress/snapshot', async (_req, res) => {
  res.status(201).json({ snapshot: await saveSnapshot('compressing-photos') });
});

// Compress a few photos per request (each takes a second or two), so the page can show progress.
router.post('/compress', async (req, res) => {
  const maxSide = number(req.body?.maxSide, 'Longest side', { required: true, integer: true, min: MIN_SIDE, max: MAX_SIDE });
  const ids = array(req.body?.ids, 'ids').map((id, i) => uuid(id, `Photo ${i + 1}`));
  if (ids.length > 10) throw badRequest('Compress at most 10 photos per request');
  const results = [];
  for (const id of ids) results.push(await compressPhoto(id, maxSide));
  res.json({ results });
});

// Turn a photo a quarter turn: { direction: 'left' | 'right' }. Returns the image with its new URLs.
router.post('/:id/rotate', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const direction = req.body?.direction;
  if (direction !== 'left' && direction !== 'right') throw badRequest('Direction must be left or right');
  const status = await rotatePhoto(id, direction === 'right');
  if (status === 'missing') throw notFound('Image');
  if (status === 'unsupported') throw new HttpError(400, 'Only JPEG and PNG photos can be turned');
  const { rows } = await query('SELECT * FROM images WHERE id = $1', [id]);
  res.json(imageJson(rows[0]));
});

// Crop a photo: { x, y, width, height } as fractions of the photo (0–1). Returns the image with its new URLs.
router.post('/:id/crop', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const part = (key, label, min) => Number(number(req.body?.[key], label, { required: true, min, max: 1 }));
  const rect = { x: part('x', 'Left edge', 0), y: part('y', 'Top edge', 0), width: part('width', 'Width', 0.01), height: part('height', 'Height', 0.01) };
  if (rect.x + rect.width > 1.001 || rect.y + rect.height > 1.001) throw badRequest('The crop must stay inside the photo');
  const status = await cropPhoto(id, rect);
  if (status === 'missing') throw notFound('Image');
  if (status === 'unsupported') throw new HttpError(400, 'Only JPEG and PNG photos can be cropped');
  const { rows } = await query('SELECT * FROM images WHERE id = $1', [id]);
  res.json(imageJson(rows[0]));
});

router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT filename, mime FROM images WHERE id = $1', [uuid(req.params.id, 'id')]);
  if (!rows[0]) throw notFound('Image');
  // A file is never rewritten in place (turning or compressing a photo stores a new file, and its
  // URL names the file), so it can be cached forever.
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
