-- Spice Lab: blends of spices measured in kitchen units (pinch, tsp, tbsp, g, oz…).
CREATE TABLE spice_blends (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A spice is an ingredient from the database (so it can be costed) or just a typed name.
CREATE TABLE spice_blend_items (
  blend_id      uuid NOT NULL REFERENCES spice_blends(id) ON DELETE CASCADE,
  position      integer NOT NULL,
  ingredient_id uuid REFERENCES ingredients(id) ON DELETE RESTRICT,
  name          text,
  amount        numeric(14,4) NOT NULL CHECK (amount > 0),
  unit          text NOT NULL,
  PRIMARY KEY (blend_id, position),
  CHECK (ingredient_id IS NOT NULL OR name IS NOT NULL)
);
CREATE INDEX spice_blend_items_ingredient ON spice_blend_items (ingredient_id);

-- A recipe line is an ingredient or a whole blend (measured in tsp).
ALTER TABLE recipe_ingredients ALTER COLUMN ingredient_id DROP NOT NULL;
ALTER TABLE recipe_ingredients ADD COLUMN blend_id uuid REFERENCES spice_blends(id) ON DELETE RESTRICT;
ALTER TABLE recipe_ingredients ADD CONSTRAINT recipe_ingredients_one_item CHECK (num_nonnulls(ingredient_id, blend_id) = 1);
CREATE INDEX recipe_ingredients_blend ON recipe_ingredients (blend_id);
