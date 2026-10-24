import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

const GROUPS = ['ingredients', 'recipes', 'sauces', 'blends', 'events', 'purchases'];

// Universal header search across everything with a page: ingredients (by name or a saved receipt
// name), recipes, sauces, spice blends, events (by name or notes) and purchases (by vendor).
router.get('/', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json(Object.fromEntries(GROUPS.map((g) => [g, []])));
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const blends = (kind) => query(
    `SELECT id, name, container, servings FROM spice_blends WHERE kind = $2 AND name ILIKE $1 ORDER BY lower(name) LIMIT 6`,
    [like, kind],
  );
  const results = await Promise.all([
    query(
      `SELECT i.id, i.name, i.category,
              CASE WHEN i.name NOT ILIKE $1 THEN (SELECT a.alias FROM ingredient_aliases a
                WHERE a.ingredient_id = i.id AND a.alias ILIKE $1 ORDER BY lower(a.alias) LIMIT 1) END AS alias
         FROM ingredients i
        WHERE i.name ILIKE $1 OR EXISTS (SELECT 1 FROM ingredient_aliases a WHERE a.ingredient_id = i.id AND a.alias ILIKE $1)
        ORDER BY i.name NOT ILIKE $1, lower(i.name) LIMIT 6`,
      [like],
    ),
    query(`SELECT id, name, base_servings AS "baseServings" FROM recipes WHERE name ILIKE $1 ORDER BY lower(name) LIMIT 6`, [like]),
    blends('sauce'),
    blends('spice'),
    query(
      `SELECT id, name, event_date AS "date" FROM events WHERE name ILIKE $1 OR notes ILIKE $1
        ORDER BY name NOT ILIKE $1, event_date DESC LIMIT 6`,
      [like],
    ),
    query(
      `SELECT r.id, r.vendor AS name, r.receipt_date AS "date",
              (SELECT count(*)::int FROM ingredient_purchases p WHERE p.receipt_id = r.id) AS lines
         FROM receipts r WHERE r.vendor ILIKE $1
        ORDER BY r.receipt_date DESC NULLS LAST, r.created_at DESC LIMIT 6`,
      [like],
    ),
  ]);
  res.json(Object.fromEntries(GROUPS.map((g, i) => [g, results[i].rows])));
});

export default router;
