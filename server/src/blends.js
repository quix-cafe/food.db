// Spice blends with their spices priced from each linked ingredient's latest purchase.
import { calculateBlend } from '@kitchen/shared';
import { query } from './db.js';
import { LATEST_PURCHASE } from './sql.js';

/** Blends by id (or all, when `ids` is null), each with items and its calculateBlend breakdown. */
export async function loadBlends(ids = null, client = { query }) {
  const where = ids ? 'WHERE b.id = ANY($1::uuid[])' : '';
  const { rows: blends } = await client.query(
    `SELECT b.id, b.name, b.notes, b.servings, b.created_at AS "createdAt", b.updated_at AS "updatedAt", b.is_test AS "isTest"
     FROM spice_blends b ${where} ORDER BY lower(b.name)`,
    ids ? [ids] : [],
  );
  if (!blends.length) return [];
  const { rows: items } = await client.query(
    `SELECT si.blend_id AS "blendId", si.position, si.ingredient_id AS "ingredientId",
            coalesce(i.name, si.name) AS name, si.amount, si.unit, i.uom, i.category,
            lp.unit_cost AS "packPrice", lp.pack_size AS "packSize"
     FROM spice_blend_items si
     LEFT JOIN ingredients i ON i.id = si.ingredient_id
     ${LATEST_PURCHASE}
     WHERE si.blend_id = ANY($1::uuid[])
     ORDER BY si.blend_id, si.position`,
    [blends.map((b) => b.id)],
  );
  const byBlend = Map.groupBy(items, (it) => it.blendId);
  return blends.map((b) => ({ ...b, ...calculateBlend(byBlend.get(b.id) ?? []) }));
}

/**
 * A recipe line for a blend behaves like an ingredient measured in tsp whose "store pack"
 * is one batch: packSize = the batch's teaspoons, packPrice = what the batch's spices cost.
 */
export function blendAsLine(blend) {
  return {
    name: blend.name,
    category: 'Spice blend',
    uom: 'tsp',
    packSize: blend.totalTsp,
    packPrice: blend.cost,
    blendCostComplete: blend.costComplete,
    priceDate: null,
    vendor: null,
  };
}
