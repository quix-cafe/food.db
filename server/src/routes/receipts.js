import { Router } from 'express';
import { Decimal } from '@kitchen/shared';
import { query, tx } from '../db.js';
import { normalizeReceipt, receiptTime } from '../services/receipt.js';
import { matchItems, vendorSpelling } from '../matching.js';
import { uploadImages, attachImages, listImages, imageRoutes, deleteImageOwner } from '../images.js';
import { badRequest, notFound, text, date, uuid } from '../validate.js';

const router = Router();

const RECEIPT_COLUMNS = `r.id, r.vendor, r.receipt_date AS "date", r.created_at AS "createdAt", r.is_test AS "isTest",
  (SELECT count(*)::int FROM receipt_lines l WHERE l.receipt_id = r.id AND l.purchase_id IS NULL) AS "pendingCount",
  (SELECT count(*)::int FROM ingredient_purchases p WHERE p.receipt_id = r.id) AS "lineCount",
  (SELECT coalesce(sum(p.total_cost), 0) FROM ingredient_purchases p WHERE p.receipt_id = r.id) AS "savedTotal"`;

/** Store the normalised lines of `source` for a receipt (same order the import screen used). */
async function extractLines(c, receiptId, source) {
  let items = [];
  try {
    items = source ? normalizeReceipt(source).items : [];
  } catch {
    items = []; // source that no longer parses just has no lines to offer
  }
  for (const [position, it] of items.entries()) {
    await c.query(
      `INSERT INTO receipt_lines (receipt_id, position, name, category, quantity, unit, unit_cost, total_cost, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [receiptId, position, it.name, it.category, it.quantity, it.unit, it.unitCost, it.totalCost, it.note],
    );
  }
}

// GET /api/receipts — newest first, with their images and the time printed on each ('HH:MM', or null).
router.get('/', async (_req, res) => {
  const { rows } = await query(`SELECT ${RECEIPT_COLUMNS}, r.source FROM receipts r ORDER BY coalesce(r.receipt_date, r.created_at::date) DESC, r.created_at DESC`);
  const images = await listImages({ query }, 'receipt', rows.map((r) => r.id));
  res.json(rows.map(({ source, ...r }) => ({ ...r, time: receiptTime(source), images: images.get(r.id) })));
});

// Create a receipt (multipart: `images` files + `vendor`, `date`, `source` JSON text).
// Called from the review grid on first save; its purchases then reference it.
router.post('/', uploadImages, async (req, res) => {
  const vendor = text(req.body?.vendor, 'Vendor', { max: 120 });
  const day = date(req.body?.date, 'Date');
  let source = null;
  if (req.body?.source) {
    try {
      source = JSON.parse(req.body.source);
    } catch {
      throw badRequest('Receipt source must be JSON');
    }
  }
  const id = await tx(async (c) => {
    const { rows } = await c.query(
      'INSERT INTO receipts (vendor, receipt_date, source) VALUES ($1,$2,$3) RETURNING id',
      [await vendorSpelling(c, vendor), day, source],
    );
    await attachImages(c, 'receipt', rows[0].id, req.files);
    await extractLines(c, rows[0].id, source);
    return rows[0].id;
  });
  res.status(201).json(await getReceipt(id));
});

async function getReceipt(id) {
  const { rows } = await query(`SELECT ${RECEIPT_COLUMNS}, r.source FROM receipts r WHERE r.id = $1`, [id]);
  if (!rows[0]) throw notFound('Receipt');
  const [images, purchases, pending] = await Promise.all([
    listImages({ query }, 'receipt', [id]),
    query(
      `SELECT p.id, p.ingredient_id AS "ingredientId", i.name AS "ingredientName", i.category, i.uom,
              p.quantity, p.pack_size AS "packSize", p.unit_cost AS "unitCost", p.total_cost AS "totalCost"
       FROM ingredient_purchases p JOIN ingredients i ON i.id = p.ingredient_id
       WHERE p.receipt_id = $1 ORDER BY p.created_at, lower(i.name)`,
      [id],
    ),
    // Lines from the JSON that haven't been saved as purchases (skipped during review).
    query(
      `SELECT position AS line, name, category, quantity, unit, unit_cost AS "unitCost", total_cost AS "totalCost", note
       FROM receipt_lines WHERE receipt_id = $1 AND purchase_id IS NULL ORDER BY position`,
      [id],
    ),
  ]);
  const pendingLines = await matchItems({ query }, pending.rows.map((l) => ({
    ...l,
    quantity: new Decimal(l.quantity).toString(),
    unitCost: l.unitCost === null ? null : new Decimal(l.unitCost).toString(),
    totalCost: l.totalCost === null ? null : new Decimal(l.totalCost).toString(),
  })));
  return { ...rows[0], time: receiptTime(rows[0].source), images: images.get(id), purchases: purchases.rows, pendingLines };
}

router.get('/:id', async (req, res) => {
  res.json(await getReceipt(uuid(req.params.id, 'id')));
});

imageRoutes(router, 'receipt');

// Removes the receipt and its photos; the purchases stay as price history.
router.delete('/:id', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  await deleteImageOwner('receipt', id);
  res.status(204).end();
});

export default router;
