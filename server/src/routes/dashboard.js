import { Router } from 'express';
import { Decimal } from '@kitchen/shared';
import { query } from '../db.js';
import { date } from '../validate.js';
import { loadRecipes, withCosting } from './recipes.js';

const router = Router();

const UPCOMING_SHOWN = 5;
const TOP_ITEMS = 10;

// GET /api/dashboard?today=YYYY-MM-DD (the browser's day; the server may be on another clock).
// Upcoming events, revenue against purchases by day, what sells most, and a few figures.
// Test data only counts while in test mode, but a test event still lists as upcoming: it's on the calendar.
router.get('/', async (req, res) => {
  const today = date(req.query.today, 'today') ?? new Date().toISOString().slice(0, 10);
  const real = (table) => (req.testData ? 'true' : `NOT ${table}.is_test`);
  const [counts, upcoming, last, sales, spend, recipes, days, topItems] = await Promise.all([
    query(
      `SELECT (SELECT count(*)::int FROM events e WHERE ${real('e')}) AS events,
              (SELECT count(*)::int FROM events e WHERE e.event_date >= $1) AS upcoming`,
      [today],
    ),
    query(
      `SELECT e.id, e.name, e.event_date AS "date", e.guest_count AS "guestCount", e.is_test AS "isTest",
              (SELECT count(*)::int FROM event_recipes er WHERE er.event_id = e.id) AS "recipeCount",
              (SELECT count(*)::int FROM event_blends eb WHERE eb.event_id = e.id) AS "sauceCount",
              (SELECT coalesce(sum(er.expected_servings), 0)::int FROM event_recipes er WHERE er.event_id = e.id) AS "totalServings",
              (SELECT count(*)::int FROM event_sales s WHERE s.event_id = e.id AND s.status = 'in_progress') AS "openOrders"
         FROM events e
        WHERE e.event_date >= $1
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
    // A purchase without a receipt is a trip of its own.
    query(
      `SELECT coalesce(sum(p.total_cost), 0) AS spent, count(DISTINCT coalesce(p.receipt_id, p.id))::int AS trips
         FROM ingredient_purchases p JOIN ingredients i ON i.id = p.ingredient_id
        WHERE ${real('p')} AND p.purchase_date BETWEEN $1::date - 30 AND $1::date`,
      [today],
    ),
    query(`SELECT r.id FROM recipes r WHERE ${real('r')}`),
    // A day's purchases on receipts, and its revenue: what an event says it took, else its recorded sales, before any payment fees.
    query(
      `WITH purchases AS (
         SELECT p.purchase_date AS day, sum(p.total_cost) AS amount
           FROM ingredient_purchases p JOIN ingredients i ON i.id = p.ingredient_id
          WHERE ${real('p')} AND p.receipt_id IS NOT NULL
          GROUP BY 1
       ), revenue AS (
         SELECT e.event_date AS day,
                sum(coalesce(e.actual_revenue, (SELECT sum(i.amount) FROM event_sales s JOIN event_sale_items i ON i.sale_id = s.id
                                                 WHERE s.event_id = e.id AND s.status <> 'cancelled'))) AS amount
           FROM events e WHERE ${real('e')}
          GROUP BY 1
       )
       SELECT coalesce(p.day, n.day) AS "date", p.amount::numeric(14,2) AS purchases, nullif(n.amount, 0)::numeric(14,2) AS revenue
         FROM purchases p FULL JOIN revenue n ON n.day = p.day
        WHERE p.amount IS NOT NULL OR nullif(n.amount, 0) IS NOT NULL
        ORDER BY 1`,
    ),
    // How much of each recipe or sauce sold at any event, in its own servings, so "3 tacos for $14" counts 3.
    // A deleted one keeps the name it was sold under.
    query(
      `SELECT i.recipe_id AS "recipeId", i.blend_id AS "blendId", coalesce(r.name, b.name, i.name) AS name, round(sum(i.quantity * i.recipe_servings), 2)::float8 AS sold
         FROM event_sale_items i
         JOIN event_sales s ON s.id = i.sale_id JOIN events e ON e.id = s.event_id
         LEFT JOIN recipes r ON r.id = i.recipe_id LEFT JOIN spice_blends b ON b.id = i.blend_id
        WHERE ${real('e')} AND s.status <> 'cancelled' AND s.payment_method <> 'free'
        GROUP BY 1, 2, 3
        ORDER BY sold DESC, lower(coalesce(r.name, b.name, i.name)) LIMIT ${TOP_ITEMS}`,
    ),
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
    days: days.rows,
    topItems: topItems.rows,
  });
});

export default router;
