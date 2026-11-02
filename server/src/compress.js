// Shrinking stored photos (Backup page, "Compress photos"): any recipe or receipt photo larger
// than a chosen size on its longest side is resampled down to it, in place of the original.
// JPEG and PNG only (what jimp can both read and write here); WebP and GIF are left alone.

import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { query } from './db.js';
import { removeFiles, uploadDir } from './images.js';
import { Jimp } from './thumbs.js';

export const COMPRESSIBLE = new Set(['image/jpeg', 'image/png']);
/** Smallest and largest longest side the page offers. */
export const MIN_SIDE = 1024;
export const MAX_SIDE = 4096;
const JPEG_QUALITY = 85;

const SOF = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** Width and height from a JPEG, PNG or GIF file's header, or null. Cheap: nothing is decoded. */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString('ascii', 0, 4) === 'GIF8') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; } // fill byte
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; } // no length
      if (SOF(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

const sizes = new Map(); // filename → { width, height } (files are replaced, never rewritten, so this holds)

/**
 * Every photo with its size on disk and dimensions, so the page can estimate any setting:
 * [{ id, bytes, width, height, compressible }]. A missing or unreadable file is left out.
 */
export async function photoSizes() {
  const { rows } = await query('SELECT id, filename, mime FROM images ORDER BY created_at, id');
  const out = [];
  for (const r of rows) {
    const file = path.join(uploadDir(), r.filename);
    let bytes;
    try {
      bytes = (await stat(file)).size;
      if (!sizes.has(r.filename)) sizes.set(r.filename, imageSize(await readFile(file)));
    } catch {
      continue;
    }
    const dims = sizes.get(r.filename);
    out.push({ id: r.id, bytes, width: dims?.width ?? null, height: dims?.height ?? null, compressible: COMPRESSIBLE.has(r.mime) && !!dims });
  }
  return out;
}

/**
 * Resample one photo so its longest side is at most `maxSide`, writing it under a new file name
 * and removing the old file (and its thumbnail). Returns { id, before, after, status }: 'done',
 * 'small' (already within the size), 'larger' (resampling didn't save anything; kept as it was),
 * 'skipped' (a format this can't rewrite) or 'failed' (the file wouldn't decode).
 */
export async function compressPhoto(id, maxSide) {
  const { rows: [img] } = await query('SELECT filename, mime FROM images WHERE id = $1', [id]);
  if (!img) return { id, status: 'missing' };
  const file = path.join(uploadDir(), img.filename);
  const buf = await readFile(file).catch(() => null);
  if (!buf) return { id, status: 'missing' };
  const before = buf.length;
  if (!COMPRESSIBLE.has(img.mime)) return { id, before, after: before, status: 'skipped' };
  const dims = imageSize(buf);
  if (dims && Math.max(dims.width, dims.height) <= maxSide) return { id, before, after: before, status: 'small' };
  let out;
  try {
    const image = await Jimp.fromBuffer(buf); // applies the EXIF orientation, so the result needs none
    const { width, height } = image.bitmap;
    image.resize(width >= height ? { w: maxSide } : { h: maxSide });
    out = img.mime === 'image/png' ? await image.getBuffer('image/png') : await image.getBuffer('image/jpeg', { quality: JPEG_QUALITY });
  } catch {
    return { id, before, after: before, status: 'failed' };
  }
  if (out.length >= before) return { id, before, after: before, status: 'larger' };

  // A new name rather than an overwrite: a crash mid-write never leaves a half-written photo.
  const filename = `${randomUUID()}${path.extname(img.filename)}`;
  const tmp = path.join(uploadDir(), `.${filename}.partial`);
  await writeFile(tmp, out);
  await rename(tmp, path.join(uploadDir(), filename));
  const { rowCount } = await query('UPDATE images SET filename = $2, size_bytes = $3 WHERE id = $1 AND filename = $4', [id, filename, out.length, img.filename]);
  if (!rowCount) { // deleted or replaced meanwhile
    await removeFiles([filename]);
    return { id, status: 'missing' };
  }
  await removeFiles([img.filename]);
  sizes.delete(img.filename);
  return { id, before, after: out.length, status: 'done' };
}
