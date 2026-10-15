-- "Used" on a recipe line is a multiplier of the purchase unit and may exceed 1 (Use % > 100).
ALTER TABLE recipe_ingredients ALTER COLUMN use_percent TYPE numeric(12,4);
ALTER TABLE recipe_ingredients DROP CONSTRAINT recipe_ingredients_use_percent_check;
ALTER TABLE recipe_ingredients ADD CONSTRAINT recipe_ingredients_use_percent_check CHECK (use_percent >= 0);

-- A margin derived from a typed target price needs more than 2 decimals to reproduce that price.
ALTER TABLE recipes ALTER COLUMN target_margin TYPE numeric(9,6);
