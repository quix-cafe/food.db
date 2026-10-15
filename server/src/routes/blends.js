import { Router } from 'express';
import { normalizeUnit, parseAmount } from '@kitchen/shared';
import { query, tx, fkViolation } from '../db.js';
import { loadBlends } from '../blends.js';
import { HttpError, badRequest, notFound, text, number, uuid, array } from '../validate.js';

const router = Router();

function blendFields(body) {
  const items = array(body.items, 'items').map((it, i) => {
    const row = `Spice ${i + 1}`;
    const ingredientId = uuid(it.ingredientId, `${row}: ingredient`, { required: false });
    const name = ingredientId ? null : text(it.name, `${row}: name`, { required: true, max: 120 });
    const amount = parseAmount(it.amount);
    if (!amount || amount.lte(0)) throw badRequest(`${row}: amount must be above 0 (e.g. 1/2 or 0.5)`);
    const unit = normalizeUnit(it.unit);
    if (!unit) throw badRequest(`${row}: “${it.unit ?? ''}” isn’t a unit food.db knows (try pinch, dash, tsp, tbsp, cup, g or oz)`);
    return { ingredientId, name, amount: amount.toString(), unit };
  });
  return {
    name: text(body.name, 'Blend name', { required: true, max: 120 }),
    notes: text(body.notes, 'Notes', { max: 4000 }),
    servings: number(body.servings, 'Servings', { integer: true, min: 1 }) ?? 1,
    items,
  };
}

async function writeItems(c, blendId, items) {
  await c.query('DELETE FROM spice_blend_items WHERE blend_id = $1', [blendId]);
  for (const [position, it] of items.entries()) {
    await c.query(
      'INSERT INTO spice_blend_items (blend_id, position, ingredient_id, name, amount, unit) VALUES ($1,$2,$3,$4,$5,$6)',
      [blendId, position, it.ingredientId, it.name, it.amount, it.unit],
    );
  }
}

async function getOne(id) {
  const [blend] = await loadBlends([id]);
  if (!blend) throw notFound('Spice blend');
  return blend;
}


// GET /api/blends?q= — every blend with its breakdown (also used to add blends to recipes).
router.get('/', async (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const blends = await loadBlends();
  res.json(q ? blends.filter((b) => b.name.toLowerCase().includes(q)) : blends);
});

router.get('/:id', async (req, res) => {
  res.json(await getOne(uuid(req.params.id, 'id')));
});

router.post('/', async (req, res) => {
  const f = blendFields(req.body ?? {});
  try {
    const id = await tx(async (c) => {
      const { rows } = await c.query('INSERT INTO spice_blends (name, notes, servings) VALUES ($1,$2,$3) RETURNING id', [f.name, f.notes, f.servings]);
      await writeItems(c, rows[0].id, f.items);
      return rows[0].id;
    });
    res.status(201).json(await getOne(id));
  } catch (err) {
    if (fkViolation(err)) throw badRequest('One of the spices is no longer in the ingredient database');
    throw err;
  }
});

router.put('/:id', async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const f = blendFields(req.body ?? {});
  try {
    await tx(async (c) => {
      const { rowCount } = await c.query('UPDATE spice_blends SET name=$2, notes=$3, servings=$4, updated_at=now() WHERE id=$1', [id, f.name, f.notes, f.servings]);
      if (!rowCount) throw notFound('Spice blend');
      await writeItems(c, id, f.items);
    });
  } catch (err) {
    if (fkViolation(err)) throw badRequest('One of the spices is no longer in the ingredient database');
    throw err;
  }
  res.json(await getOne(id));
});

router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await query('DELETE FROM spice_blends WHERE id = $1', [uuid(req.params.id, 'id')]);
    if (!rowCount) throw notFound('Spice blend');
  } catch (err) {
    if (fkViolation(err)) throw new HttpError(409, 'This blend is used in a recipe. Remove it from those recipes first.');
    throw err;
  }
  res.status(204).end();
});

export default router;
