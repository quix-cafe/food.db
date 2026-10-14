// Image storage: files in UPLOAD_DIR, metadata in the `images` table. Each image
// belongs to exactly one recipe or receipt (owner column `recipe_id` / `receipt_id`).

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { HttpError } from './validate.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Resolved lazily so tests can point UPLOAD_DIR at a temp dir before first use. */
export const uploadDir = () => path.resolve(repoRoot, process.env.UPLOAD_DIR ?? 'data/uploads');

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export const uploadImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 20, fieldSize: 2 * 1024 * 1024 },
}).array('images', 20);

/** Identify the format from the file's first bytes, not its name or claimed type. */
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.length > 6 && buf.toString('ascii', 0, 4) === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  if (buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1)/.test(buf.toString('ascii', 8, 12))) return { heic: true };
  return null;
}

export const OWNER_COLUMNS = { recipe: 'recipe_id', receipt: 'receipt_id' };

export const imageJson = (row) => ({
  id: row.id,
  url: `/api/images/${row.id}`,
  originalName: row.original_name,
  position: row.position,
});

/**
 * Write uploaded files to disk and record them for `owner` ('recipe' | 'receipt'),
 * appended after any existing images. Files are removed again if the insert fails.
 */
export async function attachImages(client, owner, ownerId, files) {
  if (!files?.length) return [];
  const prepared = files.map((f, i) => {
    const kind = sniff(f.buffer);
    if (kind?.heic) throw new HttpError(400, `${f.originalname}: HEIC photos can’t be shown in a browser. Export it as JPEG and upload again.`);
    if (!kind) throw new HttpError(400, `${f.originalname || `File ${i + 1}`} isn’t a JPEG, PNG, WebP or GIF image.`);
    return { ...kind, file: f, filename: `${randomUUID()}.${kind.ext}` };
  });

  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const written = [];
  try {
    for (const p of prepared) {
      await writeFile(path.join(dir, p.filename), p.file.buffer, { flag: 'wx' });
      written.push(p.filename);
    }
    const col = OWNER_COLUMNS[owner];
    const { rows: [{ next }] } = await client.query(
      `SELECT coalesce(max(position) + 1, 0)::int AS next FROM images WHERE ${col} = $1`,
      [ownerId],
    );
    const rows = [];
    for (const [i, p] of prepared.entries()) {
      const { rows: [row] } = await client.query(
        `INSERT INTO images (${col}, filename, mime, size_bytes, original_name, position)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ownerId, p.filename, p.mime, p.file.size, p.file.originalname || null, next + i],
      );
      rows.push(imageJson(row));
    }
    return rows;
  } catch (err) {
    await removeFiles(written);
    throw err;
  }
}

export async function listImages(client, owner, ownerIds) {
  const col = OWNER_COLUMNS[owner];
  const { rows } = await client.query(
    `SELECT *, ${col} AS owner FROM images WHERE ${col} = ANY($1::uuid[]) ORDER BY position, created_at`,
    [ownerIds],
  );
  const byOwner = new Map(ownerIds.map((id) => [id, []]));
  for (const r of rows) byOwner.get(r.owner)?.push(imageJson(r));
  return byOwner;
}

/** Filenames owned by the given owner; read these before deleting the owner row. */
export async function ownedFilenames(client, owner, ownerId) {
  const { rows } = await client.query(`SELECT filename FROM images WHERE ${OWNER_COLUMNS[owner]} = $1`, [ownerId]);
  return rows.map((r) => r.filename);
}

export async function removeFiles(filenames) {
  await Promise.all(filenames.map((f) => rm(path.join(uploadDir(), f), { force: true })));
}

/** Copy an owner's images (files and rows) to another owner of the same kind. */
export async function copyImages(client, owner, fromId, toId) {
  const col = OWNER_COLUMNS[owner];
  const { rows } = await client.query(`SELECT * FROM images WHERE ${col} = $1 ORDER BY position`, [fromId]);
  const copied = [];
  try {
    for (const r of rows) {
      const filename = `${randomUUID()}${path.extname(r.filename)}`;
      await copyFile(path.join(uploadDir(), r.filename), path.join(uploadDir(), filename));
      copied.push(filename);
      await client.query(
        `INSERT INTO images (${col}, filename, mime, size_bytes, original_name, position) VALUES ($1,$2,$3,$4,$5,$6)`,
        [toId, filename, r.mime, r.size_bytes, r.original_name, r.position],
      );
    }
  } catch (err) {
    await removeFiles(copied);
    throw err;
  }
}

/** Rewrite positions so `orderedIds` (all of the owner's images) appear in that order. */
export async function reorderImages(client, owner, ownerId, orderedIds) {
  const col = OWNER_COLUMNS[owner];
  const { rows } = await client.query(`SELECT id FROM images WHERE ${col} = $1`, [ownerId]);
  const current = new Set(rows.map((r) => r.id));
  if (orderedIds.length !== current.size || !orderedIds.every((id) => current.has(id))) {
    throw new HttpError(400, 'The new order must list each of this item’s images exactly once');
  }
  for (const [position, id] of orderedIds.entries()) {
    await client.query('UPDATE images SET position = $2 WHERE id = $1', [id, position]);
  }
}
