import { Router } from 'express';
import { Decimal } from '@kitchen/shared';
import { query } from '../db.js';
import { date } from '../validate.js';
import { loadRecipes, withCosting } from './recipes.js';

const router = Router();

const UPCOMING_SHOWN = 5;

// GET /api/dashboard?today=YYYY-MM-DD (the browser's day; the server may be on another clock).
// Upcoming events and a figure for each kind of data. Test data only counts while in test mode.
router.get('/', async (req, res) => {
  const today = date(req.query.today, 'today') ?? new Date().toISOString().slice(0, 10);
  const real = (table) => (req.testData ? 'true' : `NOT ${table}.is_test`);
  const [counts, upcoming, last, sales, spend, recipes] = await Promise.all([
    query(
      `SELECT (SELECT count(*)::int FROM ingredients i WHERE ${real('i')} AND NOT is_labor(i.name, i.category)) AS ingredients,
              (SELECT count(*)::int FROM ingredients i WHERE ${real('i')} AND NOT is_labor(i.name, i.category)
                 AND NOT EXISTS (SELECT 1 FROM ingredient_purchases p WHERE p.ingredient_id = i.id)) AS unpriced,
              (SELECT count(*)::int FROM spice_blends b WHERE ${real('b')} AND b.kind = 'spice') AS blends,
              (SELECT count(*)::int FROM spice_blends b WHERE ${real('b')} AND b.kind = 'sauce') AS sauces,
              (SELECT count(*)::int FROM events e WHERE ${real('e')}) AS events,
              (SELECT count(*)::int FROM events e WHERE ${real('e')} AND e.event_date >= $1) AS upcoming`,
      [today],
    ),
    query(
      `SELECT e.id, e.name, e.event_date AS "date", e.guest_count AS "guestCount", e.is_test AS "isTest",
              (SELECT count(*)::int FROM event_recipes er WHERE er.event_id = e.id) AS "recipeCount",
              (SELECT count(*)::int FROM event_blends eb WHERE eb.event_id = e.id) AS "sauceCount",
              (SELECT coalesce(sum(er.expected_servings), 0)::int FROM event_recipes er WHERE er.event_id = e.id) AS "totalServings",
              (SELECT count(*)::int FROM event_sales s WHERE s.event_id = e.id AND s.status IN ('placed', 'in_progress')) AS "openOrders"
         FROM events e
        WHERE ${real('e')} AND e.event_date >= $1
        ORDER BY e.event_date, lower(e.name) LIMIT ${UPCOMING_SHOWN}`,
      [today],
    ),
    query(
      `SELECT e.id, e.name, e.event_date AS "date",
              (SELECT count(*)::int FROM event_sales s WHERE s.event_id = e.id AND s.status <> 'cancelled') AS orders,
              (SELECT coalesce(sum(i.amount), 0) FROM event_sales s JOIN event_sale_items i ON i.sale_id = s.id
                WHERE s.event_id = e.id AND s.status <> 'cancelled') AS revenue
         FROM events e
        WHERE ${real('e')} AND e.event_date < $1
        ORDER BY e.event_date DESC, e.created_at DESC LIMIT 1`,
      [today],
    ),
    // Cancelled orders count for nothing, as in the event's own totals.
    query(
      `SELECT count(DISTINCT s.id)::int AS orders, coalesce(sum(i.amount), 0) AS revenue
         FROM event_sales s JOIN events e ON e.id = s.event_id JOIN event_sale_items i ON i.sale_id = s.id
        WHERE ${real('e')} AND s.status <> 'cancelled' AND e.event_date BETWEEN $1::date - 30 AND $1::date`,
      [today],
    ),
    // Labor is a rate, not something bought. A purchase without a receipt is a trip of its own.
    query(
      `SELECT coalesce(sum(p.total_cost), 0) AS spent, count(DISTINCT coalesce(p.receipt_id, p.id))::int AS trips
         FROM ingredient_purchases p JOIN ingredients i ON i.id = p.ingredient_id
        WHERE ${real('p')} AND NOT is_labor(i.name, i.category) AND p.purchase_date BETWEEN $1::date - 30 AND $1::date`,
      [today],
    ),
    query(`SELECT r.id FROM recipes r WHERE ${real('r')}`),
  ]);
  const costed = await loadRecipes(recipes.rows.map((r) => r.id));
  const margins = costed.map((r) => withCosting(r).costing.targetMargin); // with a set price, the margin it makes
  const averageMargin = margins.length
    ? margins.reduce((sum, m) => sum.plus(m), new Decimal(0)).div(margins.length).toFixed(1)
    : null;
  res.json({
    ...counts.rows[0],
    upcomingEvents: upcoming.rows,
    lastEvent: last.rows[0] ?? null,
    sales: sales.rows[0],
    spend: spend.rows[0],
    recipes: costed.length,
    averageMargin,
  });
});

export default router;
