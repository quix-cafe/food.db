import { Router } from 'express';
import { summarizeEvent } from '@kitchen/shared';
import { query, tx, fkViolation } from '../db.js';
import { loadRecipes } from './recipes.js';
import { badRequest, notFound, text, number, date, uuid, array } from '../validate.js';

const router = Router();

const EVENT_COLUMNS = `e.id, e.name, e.event_date AS "date", e.guest_count AS "guestCount", e.created_at AS "createdAt"`;

function eventFields(body) {
  const recipes = body.recipes === undefined
    ? undefined
    : array(body.recipes, 'recipes').map((r, i) => ({
        recipeId: uuid(r.recipeId, `Recipe ${i + 1}`),
        expectedServings: number(r.expectedServings, `Recipe ${i + 1}: servings`, { required: true, integer: true, min: 0 }),
      }));
  if (recipes && new Set(recipes.map((r) => r.recipeId)).size !== recipes.length) {
    throw badRequest('Each recipe can only be added to an event once');
  }
  return {
    name: text(body.name, 'Event name', { required: true }),
    date: date(body.date, 'Event date', { required: true }),
    guestCount: number(body.guestCount, 'Guest count', { integer: true, min: 0 }),
    recipes,
  };
}

async function replaceRecipes(c, eventId, recipes) {
  await c.query('DELETE FROM event_recipes WHERE event_id = $1', [eventId]);
  for (const r of recipes) {
    await c.query('INSERT INTO event_recipes (event_id, recipe_id, expected_servings) VALUES ($1,$2,$3)', [
      eventId, r.recipeId, r.expectedServings,
    ]);
  }
}

async function getEvent(id) {
  const { rows } = await query(`SELECT ${EVENT_COLUMNS} FROM events e WHERE e.id = $1`, [id]);
  if (!rows[0]) throw notFound('Event');
  const { rows: recipes } = await query(
    `SELECT er.recipe_id AS "recipeId", r.name, r.base_servings AS "baseServings",
            er.expected_servings AS "expectedServings"
     FROM event_recipes er JOIN recipes r ON r.id = er.recipe_id
     WHERE er.event_id = $1 ORDER BY lower(r.name)`,
    [id],
  );
  return { ...rows[0], recipes };
}


// GET /api/events?date=YYYY-MM-DD
router.get('/', async (req, res) => {
  const day = date(req.query.date, 'date');
  const { rows } = await query(
    `SELECT ${EVENT_COLUMNS},
            count(er.recipe_id)::int AS "recipeCount",
            coalesce(sum(er.expected_servings), 0)::int AS "totalServings"
     FROM events e LEFT JOIN event_recipes er ON er.event_id = e.id
     ${day ? 'WHERE e.event_date = $1' : ''}
     GROUP BY e.id
     ORDER BY e.event_date DESC, lower(e.name)`,
    day ? [day] : [],
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const f = eventFields(req.body ?? {});
  try {
    const id = await tx(async (c) => {
      const { rows } = await c.query(
        'INSERT INTO events (name, event_date, guest_count) VALUES ($1,$2,$3) RETURNING id',
        [f.name, f.date, f.guestCount],
      );
      if (f.recipes) await replaceRecipes(c, rows[0].id, f.recipes);
      return rows[0].id;
    });
    res.status(201).json(await getEvent(id));
  } catch (err) {
    if (fkViolation(err)) throw badRequest('One of the recipes no longer exists');
    throw err;
  }
});

router.get('/:id', async (req, res) => {
  res.json(await getEvent(uuid(req.params.id, 'id')));
});

router.put('/:id', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const f = eventFields(req.body ?? {});
  try {
    await tx(async (c) => {
      const { rowCount } = await c.query(
        'UPDATE events SET name=$2, event_date=$3, guest_count=$4 WHERE id=$1',
        [id, f.name, f.date, f.guestCount],
      );
      if (!rowCount) throw notFound('Event');
      if (f.recipes) await replaceRecipes(c, id, f.recipes);
    });
  } catch (err) {
    if (fkViolation(err)) throw badRequest('One of the recipes no longer exists');
    throw err;
  }
  res.json(await getEvent(id));
});

// Attach (or update) a single recipe — used by "Add to Event" in the gallery.
router.post('/:id/recipes', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const recipeId = uuid(req.body?.recipeId, 'Recipe');
  const servings = number(req.body?.expectedServings, 'Servings', { required: true, integer: true, min: 0 });
  try {
    await query(
      `INSERT INTO event_recipes (event_id, recipe_id, expected_servings) VALUES ($1,$2,$3)
       ON CONFLICT (event_id, recipe_id) DO UPDATE SET expected_servings = EXCLUDED.expected_servings`,
      [id, recipeId, servings],
    );
  } catch (err) {
    if (fkViolation(err)) throw notFound('Event or recipe');
    throw err;
  }
  res.status(201).json(await getEvent(id));
});

router.delete('/:id', async (req, res) => {
  const { rowCount } = await query('DELETE FROM events WHERE id = $1', [uuid(req.params.id, 'id')]);
  if (!rowCount) throw notFound('Event');
  res.status(204).end();
});

// Aggregated financials and the consolidated shopping list.
router.get('/:id/summary', async (req, res) => {
  const event = await getEvent(uuid(req.params.id, 'id'));
  const recipes = await loadRecipes(event.recipes.map((r) => r.recipeId));
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const summary = summarizeEvent(
    event.recipes.map((er) => {
      const r = byId.get(er.recipeId);
      return {
        recipeId: r.id,
        name: r.name,
        baseServings: r.baseServings,
        targetMargin: r.targetMargin,
        expectedServings: er.expectedServings,
        lines: r.lines,
      };
    }),
    await loadAmounts(event.id),
  );
  res.json({ event, ...summary });
});

async function loadAmounts(eventId) {
  const { rows } = await query('SELECT ingredient_id, amount FROM event_amounts WHERE event_id = $1', [eventId]);
  return Object.fromEntries(rows.map((r) => [r.ingredient_id, r.amount]));
}

// Set the shopping list's "needed" amount for one ingredient by hand (labor), or clear it
// to go back to the recipes' scaled total.
router.put('/:id/amounts/:ingredientId', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const ingredientId = uuid(req.params.ingredientId, 'ingredientId');
  const amount = number(req.body?.amount, 'Needed', { required: true, min: 0 });
  try {
    await query(
      `INSERT INTO event_amounts (event_id, ingredient_id, amount) VALUES ($1,$2,$3)
       ON CONFLICT (event_id, ingredient_id) DO UPDATE SET amount = EXCLUDED.amount`,
      [id, ingredientId, amount],
    );
  } catch (err) {
    if (fkViolation(err)) throw notFound('Event or ingredient');
    throw err;
  }
  res.status(204).end();
});

router.delete('/:id/amounts/:ingredientId', async (req, res) => {
  await query('DELETE FROM event_amounts WHERE event_id = $1 AND ingredient_id = $2', [
    uuid(req.params.id, 'id'), uuid(req.params.ingredientId, 'ingredientId'),
  ]);
  res.status(204).end();
});

export default router;
