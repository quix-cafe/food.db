import { Router } from 'express';
import { SAUCE_CONTAINERS, normalizeUnit, parseAmount } from '@kitchen/shared';
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
    // A linked ingredient can also be measured in its own unit (checked in checkUnits).
    const unit = normalizeUnit(it.unit) ?? (ingredientId ? text(it.unit, `${row}: unit`, { max: 40 })?.toLowerCase() : null);
    if (!unit) throw badRequest(`${row}: “${it.unit ?? ''}” isn’t a unit food.db knows (try pinch, dash, tsp, tbsp, cup, g, oz or bunch)`);
    return { row, ingredientId, name, amount: amount.toString(), unit };
  });
  const kind = body.kind === 'sauce' ? 'sauce' : 'spice';
  const container = kind === 'sauce' ? body.container : null;
  if (kind === 'sauce' && !Object.hasOwn(SAUCE_CONTAINERS, container)) {
    throw badRequest(`Container must be one of ${Object.keys(SAUCE_CONTAINERS).join(', ')}`);
  }
  return {
    name: text(body.name, 'Blend name', { required: true, max: 120 }),
    kind,
    container,
    notes: text(body.notes, 'Notes', { max: 4000 }),
    servings: number(body.servings, 'Servings', { integer: true, min: 1 }) ?? 1,
    items,
  };
}

/** Units food.db doesn't know are allowed only when they're the linked ingredient's own unit. */
async function checkUnits(c, items) {
  const odd = items.filter((it) => !normalizeUnit(it.unit));
  if (!odd.length) return;
  const { rows } = await c.query('SELECT id, lower(trim(uom)) AS uom FROM ingredients WHERE id = ANY($1::uuid[])', [odd.map((it) => it.ingredientId)]);
  const uoms = new Map(rows.map((r) => [r.id, r.uom]));
  const bad = odd.find((it) => uoms.get(it.ingredientId) !== it.unit);
  if (bad) throw badRequest(`${bad.row}: “${bad.unit}” isn’t a unit food.db knows (try pinch, dash, tsp, tbsp, cup, g, oz or bunch)`);
}

async function writeItems(c, blendId, items) {
  await checkUnits(c, items);
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
      const { rows } = await c.query('INSERT INTO spice_blends (name, kind, container, notes, servings) VALUES ($1,$2,$3,$4,$5) RETURNING id', [f.name, f.kind, f.container, f.notes, f.servings]);
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
  // A blend stays a blend and a sauce a sauce: recipes measure them in g and oz.
  const { rows: [current] } = await query('SELECT kind FROM spice_blends WHERE id = $1', [id]);
  if (!current) throw notFound('Spice blend');
  const f = blendFields({ ...req.body, kind: current.kind });
  try {
    await tx(async (c) => {
      const { rowCount } = await c.query('UPDATE spice_blends SET name=$2, container=$3, notes=$4, servings=$5, updated_at=now() WHERE id=$1', [id, f.name, f.container, f.notes, f.servings]);
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
    if (fkViolation(err)) throw new HttpError(409, 'This is used in a recipe or an event. Remove it from those first.');
    throw err;
  }
  res.status(204).end();
});

export default router;
