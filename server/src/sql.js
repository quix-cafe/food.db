// SQL fragments shared across routes.

/**
 * Joins `lp` = the current price of ingredient alias `i`: its most recent purchase, averaged
 * with any other lines of that purchase's receipt (two packs of chicken at different weights
 * are one trip's price, not a price change). The pack price and pack size are averaged per
 * pack bought, as `combinePurchases` does; `lines` is how many purchases went into it.
 */
export const LATEST_PURCHASE = `
  LEFT JOIN LATERAL (
    SELECT last.id, last.vendor, last.purchase_date, last.created_at, trip.unit_cost, trip.pack_size, trip.lines
    FROM (
      SELECT p.id, p.receipt_id, p.vendor, p.purchase_date, p.created_at
      FROM ingredient_purchases p
      WHERE p.ingredient_id = i.id
      ORDER BY p.purchase_date DESC, p.created_at DESC
      LIMIT 1
    ) last
    CROSS JOIN LATERAL (
      SELECT round(sum(t.quantity * t.unit_cost) / sum(t.quantity), 4) AS unit_cost,
             round(sum(t.quantity * t.pack_size) / sum(t.quantity), 4) AS pack_size,
             count(*)::int AS lines
      FROM ingredient_purchases t
      WHERE t.ingredient_id = i.id AND (t.id = last.id OR t.receipt_id = last.receipt_id)
    ) trip
  ) lp ON true`;

export const INGREDIENT_COLUMNS = `
  i.id, i.name, i.category, i.uom,
  i.created_at AS "createdAt", i.is_test AS "isTest",
  lp.unit_cost AS "latestPackPrice",
  lp.pack_size AS "latestPackSize",
  round(lp.unit_cost / lp.pack_size, 4) AS "latestUnitPrice",
  lp.vendor AS "latestVendor",
  lp.purchase_date AS "latestPurchaseDate",
  lp.lines AS "latestLines"`;

/** Recipe lines with the ingredient's latest price, for the given recipe ids ($1 uuid[]). */
export const RECIPE_LINES = `
  SELECT ri.recipe_id AS "recipeId", ri.position, ri.blend_id AS "blendId",
         i.id AS "ingredientId", i.name, i.category,
         i.uom, ri.amount,
         lp.unit_cost AS "packPrice", lp.pack_size AS "packSize", lp.vendor, lp.purchase_date AS "priceDate",
         lp.created_at AS "priceSyncedAt"
  FROM recipe_ingredients ri
  LEFT JOIN ingredients i ON i.id = ri.ingredient_id -- null for a blend line (filled in by loadRecipes)
  ${LATEST_PURCHASE}
  WHERE ri.recipe_id = ANY($1::uuid[])
  ORDER BY ri.recipe_id, ri.position`;

export const RECIPE_COLUMNS = `
  r.id, r.name, r.base_servings AS "baseServings", r.total_yield AS "totalYield",
  r.yield_unit AS "yieldUnit", r.target_margin AS "targetMargin",
  r.created_at AS "createdAt", r.updated_at AS "updatedAt", r.is_test AS "isTest"`;
