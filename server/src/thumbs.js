// Small JPEG previews of uploaded photos, so lists and galleries don't download full-size phone
// pictures. Each is made on first request and kept in UPLOAD_DIR/thumbs, named after its image's
// file. Pure JS (jimp) so the standalone binary needs no native code; WebP isn't decoded, and
// those images (or any that fail to decode) are served full size instead.

import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createJimp } from '@jimp/core';
import jpeg from '@jimp/js-jpeg';
import png from '@jimp/js-png';
import gif from '@jimp/js-gif';
import { methods as resize } from '@jimp/plugin-resize';
import { thumbDir, thumbName, uploadDir } from './images.js';

const Jimp = createJimp({ formats: [jpeg, png, gif], plugins: [resize] });

/** Longest side of a thumbnail, in pixels: a recipe card's cover at 2× density. */
export const THUMB_SIZE = 640;
const THUMBABLE = new Set(['image/jpeg', 'image/png', 'image/gif']);

/** Shrink an image file's bytes to a JPEG of at most THUMB_SIZE on its longest side. */
export async function makeThumb(buffer) {
  const image = await Jimp.fromBuffer(buffer); // applies the EXIF orientation
  const { width, height } = image.bitmap;
  if (Math.max(width, height) > THUMB_SIZE) {
    image.resize(width >= height ? { w: THUMB_SIZE } : { h: THUMB_SIZE });
  }
  // JPEG has no transparency: put see-through pixels on white rather than black.
  const px = image.bitmap.data;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255;
    if (a < 1) {
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(px[i + c] * a + 255 * (1 - a));
      px[i + 3] = 255;
    }
  }
  return image.getBuffer('image/jpeg', { quality: 78 });
}

const pending = new Map(); // filename → promise of its thumbnail path, so one request makes it

/**
 * The path of an image's thumbnail, making it if needed, or null when it can't have one
 * (an unsupported format, or a file that won't decode).
 */
export function thumbFor({ filename, mime }) {
  if (!THUMBABLE.has(mime)) return Promise.resolve(null);
  const file = path.join(thumbDir(), thumbName(filename));
  if (!pending.has(filename)) {
    const made = (async () => {
      try {
        await access(file);
        return file;
      } catch { /* not made yet */ }
      try {
        const thumb = await makeThumb(await readFile(path.join(uploadDir(), filename)));
        await mkdir(thumbDir(), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, thumb);
        await rename(tmp, file);
        return file;
      } catch {
        return null;
      }
    })().finally(() => pending.delete(filename));
    pending.set(filename, made);
  }
  return pending.get(filename);
}
