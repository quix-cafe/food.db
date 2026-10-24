// Spice blends with their spices priced from each linked ingredient's latest purchase.
import { calculateBlend } from '@kitchen/shared';
import { query } from './db.js';
import { LATEST_PURCHASE } from './sql.js';

/** Blends by id (or all, when `ids` is null), each with items and its calculateBlend breakdown. */
export async function loadBlends(ids = null, client = { query }) {
  const where = ids ? 'WHERE b.id = ANY($1::uuid[])' : '';
  const { rows: blends } = await client.query(
    `SELECT b.id, b.name, b.kind, b.container, b.notes, b.servings, b.serving_oz AS "servingOz", b.created_at AS "createdAt", b.updated_at AS "updatedAt", b.is_test AS "isTest"
     FROM spice_blends b ${where} ORDER BY lower(b.name)`,
    ids ? [ids] : [],
  );
  if (!blends.length) return [];
  const { rows: items } = await client.query(
    `SELECT si.blend_id AS "blendId", si.position, si.ingredient_id AS "ingredientId",
            coalesce(i.name, si.name) AS name, si.amount, si.unit, i.uom, i.unit_grams AS "unitGrams", i.category,
            lp.unit_cost AS "packPrice", lp.pack_size AS "packSize", lp.vendor, lp.purchase_date AS "priceDate"
     FROM spice_blend_items si
     LEFT JOIN ingredients i ON i.id = si.ingredient_id
     ${LATEST_PURCHASE}
     WHERE si.blend_id = ANY($1::uuid[])
     ORDER BY si.blend_id, si.position`,
    [blends.map((b) => b.id)],
  );
  const byBlend = Map.groupBy(items, (it) => it.blendId);
  return blends.map((b) => ({ ...b, ...calculateBlend(byBlend.get(b.id) ?? [], b) }));
}

/**
 * A recipe line for a blend behaves like an ingredient measured in grams (a sauce: oz) whose
 * "store pack" is one batch: packSize = the batch's size, packPrice = what goes into it.
 */
export function blendAsLine(blend) {
  return {
    name: blend.name,
    category: blend.kind === 'sauce' ? 'Sauce' : 'Spice blend',
    uom: blend.uom,
    packSize: blend.batchSize,
    packPrice: blend.cost,
    blendCostComplete: blend.costComplete,
    priceDate: null,
    vendor: null,
  };
}
