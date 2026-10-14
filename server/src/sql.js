// SQL fragments shared across routes.

/** Joins `lp` = the most recent purchase of ingredient alias `i`. */
export const LATEST_PURCHASE = `
  LEFT JOIN LATERAL (
    SELECT p.id, p.unit_cost, p.unit, p.vendor, p.purchase_date, p.created_at
    FROM ingredient_purchases p
    WHERE p.ingredient_id = i.id
    ORDER BY p.purchase_date DESC, p.created_at DESC
    LIMIT 1
  ) lp ON true`;

export const INGREDIENT_COLUMNS = `
  i.id, i.name, i.category,
  i.default_yield_percent AS "defaultYieldPercent",
  i.created_at AS "createdAt",
  lp.unit_cost AS "latestUnitCost",
  lp.unit AS "latestUnit",
  lp.vendor AS "latestVendor",
  lp.purchase_date AS "latestPurchaseDate",
  lp.created_at AS "latestPriceSyncedAt"`;

/** Recipe lines with the ingredient's latest price, for the given recipe ids ($1 uuid[]). */
export const RECIPE_LINES = `
  SELECT ri.recipe_id AS "recipeId", ri.position,
         i.id AS "ingredientId", i.name, i.category,
         ri.use_percent AS "usePercent", ri.base_quantity AS "baseQuantity",
         lp.unit_cost AS "unitCost", lp.unit, lp.purchase_date AS "priceDate",
         lp.created_at AS "priceSyncedAt"
  FROM recipe_ingredients ri
  JOIN ingredients i ON i.id = ri.ingredient_id
  ${LATEST_PURCHASE}
  WHERE ri.recipe_id = ANY($1::uuid[])
  ORDER BY ri.recipe_id, ri.position`;

export const RECIPE_COLUMNS = `
  r.id, r.name, r.base_servings AS "baseServings", r.total_yield AS "totalYield",
  r.yield_unit AS "yieldUnit", r.target_margin AS "targetMargin",
  r.created_at AS "createdAt", r.updated_at AS "updatedAt"`;
