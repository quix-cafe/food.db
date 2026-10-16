import { Router } from 'express';
import { query } from '../db.js';
import { INGREDIENT_COLUMNS, LATEST_PURCHASE } from '../sql.js';
import { sendCsv } from '../csv.js';
import { today } from '../validate.js';

const router = Router();
const yesNo = (v) => (v ? 'yes' : '');

// Every ingredient with its latest price.
router.get('/ingredients.csv', async (_req, res) => {
  const { rows } = await query(`SELECT ${INGREDIENT_COLUMNS} FROM ingredients i ${LATEST_PURCHASE} ORDER BY lower(i.name)`);
  sendCsv(res, `food.db-ingredients-${today()}.csv`, [
    ['Ingredient', 'name', { text: true }],
    ['Category', 'category', { text: true }],
    ['Unit', 'uom', { text: true }],
    ['Unit price', 'latestUnitPrice'],
    ['Pack size', 'latestPackSize'],
    ['Pack price', 'latestPackPrice'],
    ['Vendor', 'latestVendor', { text: true }],
    ['Last bought', 'latestPurchaseDate'],
    ['Test data', (r) => yesNo(r.isTest)],
    ['ID', 'id'],
  ], rows);
});

// The whole price history: one row per purchase.
router.get('/purchases.csv', async (_req, res) => {
  const { rows } = await query(
    `SELECT p.purchase_date AS "date", i.name, i.category, i.uom, p.vendor, p.quantity, p.pack_size AS "packSize",
            p.unit_cost AS "packPrice", p.total_cost AS "totalCost", round(p.unit_cost / p.pack_size, 4) AS "unitPrice",
            p.receipt_id AS "receiptId", p.is_test AS "isTest", i.id AS "ingredientId"
     FROM ingredient_purchases p JOIN ingredients i ON i.id = p.ingredient_id
     ORDER BY p.purchase_date DESC, p.created_at DESC`,
  );
  sendCsv(res, `food.db-price-history-${today()}.csv`, [
    ['Date', 'date'],
    ['Ingredient', 'name', { text: true }],
    ['Category', 'category', { text: true }],
    ['Vendor', 'vendor', { text: true }],
    ['Packs bought', 'quantity'],
    ['Pack size', 'packSize'],
    ['Unit', 'uom', { text: true }],
    ['Pack price', 'packPrice'],
    ['Total', 'totalCost'],
    ['Unit price', 'unitPrice'],
    ['Receipt ID', 'receiptId'],
    ['Test data', (r) => yesNo(r.isTest)],
    ['Ingredient ID', 'ingredientId'],
  ], rows);
});

export default router;
