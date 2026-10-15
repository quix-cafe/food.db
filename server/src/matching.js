// How a receipt's wording maps to ingredients: a saved alias or exact name resolves
// automatically; otherwise the closest-looking name is offered as a suggestion only.

/** Ingredient a receipt name resolves to without asking: a saved alias, else an exact name. */
export async function resolveName(client, name) {
  const { rows } = await client.query(
    `SELECT i.id, i.name, i.category, i.uom, 'alias' AS via, 0 AS rank
       FROM ingredient_aliases a JOIN ingredients i ON i.id = a.ingredient_id
      WHERE lower(a.alias) = lower($1)
     UNION ALL
     SELECT id, name, category, uom, 'name', 1 FROM ingredients WHERE lower(name) = lower($1)
     ORDER BY rank LIMIT 1`,
    [name],
  );
  return rows[0] ?? null;
}

/** Adds `match` ({ id, name, category, uom, via }) or `suggestion` ({ id, name, category, uom }) to each item. */
export async function matchItems(client, items) {
  for (const item of items) {
    const known = await resolveName(client, item.name);
    item.match = known && { id: known.id, name: known.name, category: known.category, uom: known.uom, via: known.via };
    item.suggestion = null;
    if (!known) {
      const { rows } = await client.query(
        `SELECT id, name, category, uom FROM ingredients
         WHERE similarity(name, $1) > 0.3 ORDER BY similarity(name, $1) DESC LIMIT 1`,
        [item.name],
      );
      item.suggestion = rows[0] ?? null;
    }
  }
  return items;
}
