// SQL fragments shared across routes.

/** Joins `lp` = the most recent purchase of ingredient alias `i`. */
export const LATEST_PURCHASE = `
  LEFT JOIN LATERAL (
    SELECT p.id, p.unit_cost, p.pack_size, p.vendor, p.purchase_date, p.created_at
    FROM ingredient_purchases p
    WHERE p.ingredient_id = i.id
    ORDER BY p.purchase_date DESC, p.created_at DESC
    LIMIT 1
  ) lp ON true`;

export const INGREDIENT_COLUMNS = `
  i.id, i.name, i.category, i.uom,
  i.created_at AS "createdAt",
  lp.unit_cost AS "latestPackPrice",
  lp.pack_size AS "latestPackSize",
  round(lp.unit_cost / lp.pack_size, 4) AS "latestUnitPrice",
  lp.vendor AS "latestVendor",
  lp.purchase_date AS "latestPurchaseDate"`;

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
  r.created_at AS "createdAt", r.updated_at AS "updatedAt"`;
