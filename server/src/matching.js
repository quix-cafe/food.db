// How a receipt's wording maps to ingredients: a saved alias or exact name resolves
// automatically; otherwise ingredients sharing its words, and the closest-looking name, are offered
// as suggestions only.
//
// A generic receipt name ("Grocery" for every line at some stores) can't be trusted as an
// alias: it is only suggested, never applied, once one receipt saved it as two or more
// different ingredients, or when it is on several lines of the receipt being imported.

import { isLabor, wordMatches } from '@kitchen/shared';

/** SQL: true when the receipt name in SQL expression `name` was saved as different ingredients on one receipt. */
export const ambiguousName = (name) => `EXISTS (
  SELECT 1 FROM receipt_lines rl JOIN ingredient_purchases p ON p.id = rl.purchase_id
   WHERE lower(rl.name) = lower(${name})
   GROUP BY rl.receipt_id HAVING count(DISTINCT p.ingredient_id) > 1)`;

/**
 * Ingredient a receipt name resolves to without asking: a saved alias, else an exact name.
 * `aliases: false` skips aliases (the name is on several lines of the receipt being saved).
 */
export async function resolveName(client, name, { aliases = true } = {}) {
  const { rows } = await client.query(
    `SELECT i.id, i.name, i.category, i.uom, 'alias' AS via, 0 AS rank
       FROM ingredient_aliases a JOIN ingredients i ON i.id = a.ingredient_id
      WHERE $2 AND lower(a.alias) = lower($1) AND NOT ${ambiguousName('$1')}
     UNION ALL
     SELECT id, name, category, uom, 'name', 1 FROM ingredients WHERE lower(name) = lower($1)
     ORDER BY rank LIMIT 1`,
    [name, aliases],
  );
  return rows[0] ?? null;
}

/** The ingredients a receipt name was saved as before (or is an alias of), most often first. */
async function pastChoices(client, name) {
  const { rows } = await client.query(
    `SELECT i.id, i.name, i.category, i.uom,
            (SELECT count(*) FROM receipt_lines rl JOIN ingredient_purchases p ON p.id = rl.purchase_id
              WHERE p.ingredient_id = i.id AND lower(rl.name) = lower($1))::int AS times
       FROM ingredients i
      WHERE EXISTS (SELECT 1 FROM ingredient_aliases a WHERE a.ingredient_id = i.id AND lower(a.alias) = lower($1))
         OR EXISTS (SELECT 1 FROM receipt_lines rl JOIN ingredient_purchases p ON p.id = rl.purchase_id
                     WHERE p.ingredient_id = i.id AND lower(rl.name) = lower($1))
      ORDER BY times DESC, lower(i.name)
      LIMIT 6`,
    [name],
  );
  return rows;
}

/**
 * Adds to each item `match` ({ id, name, category, uom, via }) or `suggestion` ({ id, name, category, uom }).
 * An unmatched item also gets `candidates`: up to five ingredients it might be, best first, from the
 * words it shares with their names or saved receipt names (each with `words`), then the
 * closest-looking name if that isn't among them. `suggestion` is the first of them.
 * When a saved receipt name isn't applied because it's ambiguous, `choices` lists the ingredients it
 * was saved as before ({ …, times }) and `ambiguous` says why: 'receipt' (on several lines of this
 * receipt) or 'history' (one receipt saved it as several ingredients).
 */
export async function matchItems(client, items) {
  let everything = null; // every ingredient but labor, with its receipt names; loaded on first need
  const ingredients = async () => {
    everything ??= (await client.query(
      `SELECT i.id, i.name, i.category, i.uom,
              coalesce(json_agg(a.alias) FILTER (WHERE a.alias IS NOT NULL), '[]') AS aliases
         FROM ingredients i LEFT JOIN ingredient_aliases a ON a.ingredient_id = i.id
        GROUP BY i.id`,
    )).rows.filter((i) => !isLabor(i));
    return everything;
  };
  const lines = new Map();
  for (const item of items) lines.set(item.name.toLowerCase(), (lines.get(item.name.toLowerCase()) ?? 0) + 1);
  for (const item of items) {
    const repeated = lines.get(item.name.toLowerCase()) > 1;
    const known = await resolveName(client, item.name, { aliases: !repeated });
    item.match = known && { id: known.id, name: known.name, category: known.category, uom: known.uom, via: known.via };
    item.suggestion = null;
    item.choices = null;
    item.candidates = null;
    item.ambiguous = null;
    if (known) continue;
    const choices = await pastChoices(client, item.name);
    if (choices.length) {
      item.choices = choices;
      item.suggestion = { id: choices[0].id, name: choices[0].name, category: choices[0].category, uom: choices[0].uom };
      item.ambiguous = repeated ? 'receipt' : 'history';
      continue;
    }
    const candidates = wordMatches(item.name, await ingredients(), 4).map(({ aliases, ...c }) => c);
    const { rows } = await client.query(
      `SELECT id, name, category, uom FROM ingredients
       WHERE similarity(name, $1) > 0.3 ORDER BY similarity(name, $1) DESC LIMIT 1`,
      [item.name],
    );
    if (rows[0] && !isLabor(rows[0]) && !candidates.some((c) => c.id === rows[0].id)) candidates.push({ ...rows[0], words: [] });
    item.candidates = candidates.length ? candidates.slice(0, 5) : null;
    item.suggestion = candidates[0] ? { id: candidates[0].id, name: candidates[0].name, category: candidates[0].category, uom: candidates[0].uom } : null;
  }
  return items;
}
