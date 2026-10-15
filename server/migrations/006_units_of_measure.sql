-- rerun-on-restore
-- Units of measure. An ingredient is measured in one UOM (lb, oz, each…); each purchase
-- records its store pack size in that UOM, so price per unit = unit_cost / pack_size; a
-- recipe line records the amount used, in that UOM.
--
-- Idempotent on purpose: restoring a backup made before this migration inserts rows with
-- these columns NULL, and the restore runs this file again to convert them.

ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS uom text;
ALTER TABLE ingredient_purchases ADD COLUMN IF NOT EXISTS pack_size numeric(14,4) CHECK (pack_size > 0);
ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS amount numeric(14,4) CHECK (amount >= 0);

-- Split the old free-text unit: "case 36 lb" → 36 lb, "can 28 oz" → 28 oz, "lb" → 1 lb,
-- "bunch" → 1 bunch, "ea" → 1 each. A blank unit says nothing, so it becomes 1 of whatever
-- the ingredient is measured in (an ingredient with only blank units is measured "each").
CREATE TEMP TABLE _packs ON COMMIT DROP AS
SELECT p.id, p.ingredient_id, p.purchase_date, p.created_at,
       coalesce(m[1]::numeric, 1) AS size,
       CASE lower(coalesce(m[2], nullif(trim(p.unit), '')))
         WHEN 'ea' THEN 'each' WHEN 'ct' THEN 'each' WHEN 'pc' THEN 'each'
         ELSE coalesce(m[2], nullif(trim(p.unit), ''))
       END AS uom
FROM ingredient_purchases p
LEFT JOIN LATERAL regexp_match(trim(p.unit), '([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z][A-Za-z. ]*?)\s*$') m ON true
WHERE p.pack_size IS NULL;

-- Each ingredient takes the UOM of its latest purchase that names one.
UPDATE ingredients i SET uom = coalesce(latest.uom, 'each')
FROM (
  SELECT DISTINCT ON (ingredient_id) ingredient_id, uom
  FROM _packs ORDER BY ingredient_id, (uom IS NULL), purchase_date DESC, created_at DESC
) latest
WHERE latest.ingredient_id = i.id AND i.uom IS NULL;

-- Older purchases in a different but convertible unit are converted to the ingredient's UOM.
CREATE TEMP TABLE _conversions (from_uom text, to_uom text, factor numeric) ON COMMIT DROP;
INSERT INTO _conversions VALUES
  ('dz', 'each', 12), ('lb', 'oz', 16), ('kg', 'g', 1000), ('kg', 'lb', 2.20462), ('lb', 'g', 453.592),
  ('kg', 'oz', 35.274), ('oz', 'g', 28.3495), ('l', 'ml', 1000), ('gal', 'qt', 4), ('gal', 'l', 3.78541),
  ('qt', 'l', 0.946353), ('l', 'fl oz', 33.814), ('gal', 'fl oz', 128), ('qt', 'fl oz', 32);
INSERT INTO _conversions SELECT to_uom, from_uom, 1 / factor FROM _conversions;

UPDATE ingredient_purchases p
SET pack_size = round(k.size * coalesce(
  CASE WHEN k.uom IS NULL OR lower(k.uom) = lower(coalesce(i.uom, k.uom)) THEN 1 END,
  (SELECT c.factor FROM _conversions c WHERE c.from_uom = lower(k.uom) AND c.to_uom = lower(i.uom)),
  1), 4)
FROM _packs k JOIN ingredients i ON i.id = k.ingredient_id
WHERE p.id = k.id;

-- Recipe lines become an amount in the ingredient's UOM, keeping today's cost:
-- quantity × Use% of a purchase unit, × that purchase's pack size.
UPDATE recipe_ingredients ri
SET amount = round(ri.base_quantity * ri.use_percent / 100 * coalesce((
  SELECT p.pack_size FROM ingredient_purchases p
  WHERE p.ingredient_id = ri.ingredient_id
  ORDER BY p.purchase_date DESC, p.created_at DESC LIMIT 1
), 1), 4)
WHERE ri.amount IS NULL;

UPDATE ingredients SET uom = 'each' WHERE uom IS NULL; -- never bought

DROP TABLE _packs;
DROP TABLE _conversions;
