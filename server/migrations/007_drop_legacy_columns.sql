-- Drop the columns units of measure (006) replaced and the 004 backfill flag, and make the new
-- columns required.
-- Backups made before this migration can no longer be restored (see MIN_MIGRATION in backup.js).

ALTER TABLE ingredients DROP COLUMN default_yield_percent;
ALTER TABLE ingredient_purchases DROP COLUMN unit, DROP COLUMN weight;
ALTER TABLE recipe_ingredients DROP COLUMN base_quantity, DROP COLUMN use_percent;
ALTER TABLE receipts DROP COLUMN lines_extracted; -- only marked receipts awaiting the 004 backfill

UPDATE ingredients SET uom = 'each' WHERE uom IS NULL;
ALTER TABLE ingredients ALTER COLUMN uom SET DEFAULT 'each', ALTER COLUMN uom SET NOT NULL;

UPDATE ingredient_purchases SET pack_size = 1 WHERE pack_size IS NULL;
ALTER TABLE ingredient_purchases ALTER COLUMN pack_size SET DEFAULT 1, ALTER COLUMN pack_size SET NOT NULL;

UPDATE recipe_ingredients SET amount = 0 WHERE amount IS NULL;
ALTER TABLE recipe_ingredients ALTER COLUMN amount SET NOT NULL;
