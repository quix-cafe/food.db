// Shrinking stored photos (Backup page, "Compress photos"): any recipe or receipt photo larger
// than a chosen size on its longest side is resampled down to it, in place of the original.
// JPEG and PNG only (what jimp can both read and write here); WebP and GIF are left alone.
// Turning a photo a quarter turn (a receipt photographed sideways) rewrites it the same way.

import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { query } from './db.js';
import { removeFiles, uploadDir } from './images.js';
import { Jimp } from './thumbs.js';

const COMPRESSIBLE = new Set(['image/jpeg', 'image/png']);
/** Smallest and largest longest side the page offers. */
export const MIN_SIDE = 1024;
export const MAX_SIDE = 4096;
const JPEG_QUALITY = 85;

const SOF = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** Width and height from a JPEG, PNG or GIF file's header, or null. Cheap: nothing is decoded. */
function imageSize(buf) {
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
  if (!(await replaceFile(id, img, out))) return { id, status: 'missing' };
  return { id, before, after: out.length, status: 'done' };
}

/**
 * Turn one photo a quarter turn, clockwise or not, rewriting it under a new file name like
 * compressPhoto. Returns 'done', 'missing', or 'unsupported' (not a JPEG or PNG, or it won't decode).
 */
export async function rotatePhoto(id, clockwise) {
  const { rows: [img] } = await query('SELECT filename, mime FROM images WHERE id = $1', [id]);
  if (!img) return 'missing';
  if (!COMPRESSIBLE.has(img.mime)) return 'unsupported';
  const buf = await readFile(path.join(uploadDir(), img.filename)).catch(() => null);
  if (!buf) return 'missing';
  let out;
  try {
    const image = quarterTurn(await Jimp.fromBuffer(buf), clockwise); // fromBuffer applies the EXIF orientation
    out = img.mime === 'image/png' ? await image.getBuffer('image/png') : await image.getBuffer('image/jpeg', { quality: ROTATE_QUALITY });
  } catch {
    return 'unsupported';
  }
  return (await replaceFile(id, img, out)) ? 'done' : 'missing';
}

/**
 * Cut a photo down to a rectangle of itself. `rect` is { x, y, width, height } as fractions (0–1) of the
 * photo as it's shown (EXIF orientation applied), so the page needn't know its pixel size. JPEG and PNG
 * only; the file is replaced like a turned one. 'missing' | 'unsupported' | 'done'.
 */
export async function cropPhoto(id, rect) {
  const { rows: [img] } = await query('SELECT filename, mime FROM images WHERE id = $1', [id]);
  if (!img) return 'missing';
  if (!COMPRESSIBLE.has(img.mime)) return 'unsupported';
  const buf = await readFile(path.join(uploadDir(), img.filename)).catch(() => null);
  if (!buf) return 'missing';
  let out;
  try {
    const image = await Jimp.fromBuffer(buf);
    const { width, height } = image.bitmap;
    const x = Math.min(width - 1, Math.round(rect.x * width));
    const y = Math.min(height - 1, Math.round(rect.y * height));
    const w = Math.max(1, Math.min(width - x, Math.round(rect.width * width)));
    const h = Math.max(1, Math.min(height - y, Math.round(rect.height * height)));
    // Copied row by row, like the quarter turn: this jimp is built without its crop plugin.
    const cut = new Jimp({ width: w, height: h });
    for (let row = 0; row < h; row++) {
      const from = ((y + row) * width + x) * 4;
      image.bitmap.data.copy(cut.bitmap.data, row * w * 4, from, from + w * 4);
    }
    out = img.mime === 'image/png' ? await cut.getBuffer('image/png') : await cut.getBuffer('image/jpeg', { quality: ROTATE_QUALITY });
  } catch {
    return 'unsupported';
  }
  return (await replaceFile(id, img, out)) ? 'done' : 'missing';
}

/** Re-encoding a turned JPEG loses a little, so less is given up than when compressing. */
const ROTATE_QUALITY = 92;

function quarterTurn(image, clockwise) {
  const { width: w, height: h, data: src } = image.bitmap;
  const turned = new Jimp({ width: h, height: w });
  const dst = turned.bitmap.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const to = clockwise ? (x * h + (h - 1 - y)) * 4 : ((w - 1 - x) * h + y) * 4;
      const from = (y * w + x) * 4;
      dst[to] = src[from];
      dst[to + 1] = src[from + 1];
      dst[to + 2] = src[from + 2];
      dst[to + 3] = src[from + 3];
    }
  }
  return turned;
}

/**
 * Store `out` as an image's file in place of `img.filename`, removing the old file and its
 * thumbnail. False when the image was deleted or replaced meanwhile.
 */
async function replaceFile(id, img, out) {
  // A new name rather than an overwrite: a crash mid-write never leaves a half-written photo.
  const filename = `${randomUUID()}${path.extname(img.filename)}`;
  const tmp = path.join(uploadDir(), `.${filename}.partial`);
  await writeFile(tmp, out);
  await rename(tmp, path.join(uploadDir(), filename));
  const { rowCount } = await query('UPDATE images SET filename = $2, size_bytes = $3 WHERE id = $1 AND filename = $4', [id, filename, out.length, img.filename]);
  if (!rowCount) {
    await removeFiles([filename]);
    return false;
  }
  await removeFiles([img.filename]);
  sizes.delete(img.filename);
  return true;
}
