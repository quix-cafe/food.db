import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// Universal header search across ingredients, recipes and events.
router.get('/', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json({ ingredients: [], recipes: [], events: [] });
  const like = `%${q}%`;
  const [ingredients, recipes, events] = await Promise.all([
    query(`SELECT id, name, category FROM ingredients WHERE name ILIKE $1 ORDER BY lower(name) LIMIT 6`, [like]),
    query(`SELECT id, name, base_servings AS "baseServings" FROM recipes WHERE name ILIKE $1 ORDER BY lower(name) LIMIT 6`, [like]),
    query(`SELECT id, name, event_date AS "date" FROM events WHERE name ILIKE $1 ORDER BY event_date DESC LIMIT 6`, [like]),
  ]);
  res.json({ ingredients: ingredients.rows, recipes: recipes.rows, events: events.rows });
});

export default router;
