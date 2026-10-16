-- The schema as of migration 010, in one file (migrations 001–010 were squashed into it; see
-- SQUASHED in server/src/migrate.js for how databases and backups from before are handled).
-- Later changes go in new numbered files.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Master ingredient record; the "Asset ID" is the UUID primary key. Each ingredient is
-- measured in one unit of measure (lb, oz, each…): purchases record their store pack size
-- in it, and recipe lines their amount used.
CREATE TABLE ingredients (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  category   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  uom        text NOT NULL DEFAULT 'each'
);
CREATE UNIQUE INDEX ingredients_name_key ON ingredients (lower(name));
CREATE INDEX ingredients_name_trgm ON ingredients USING gin (name gin_trgm_ops);

-- Names a receipt used for an ingredient (e.g. "AP FLOUR 50LB" → All-purpose flour).
-- Imports resolve these automatically; each receipt name points at one ingredient.
CREATE TABLE ingredient_aliases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  alias         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ingredient_aliases_alias_key ON ingredient_aliases (lower(alias));
CREATE INDEX ingredient_aliases_ingredient ON ingredient_aliases (ingredient_id);

-- A saved receipt: where purchases came from, with the extractor's JSON and photos.
CREATE TABLE receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor       text,
  receipt_date date,
  source       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Append-only price history: new purchases never overwrite earlier ones. quantity is packs
-- bought, unit_cost the price of one pack, pack_size its size in the ingredient's UOM, so
-- price per unit = unit_cost / pack_size. Deleting a receipt keeps its purchases.
CREATE TABLE ingredient_purchases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  purchase_date date NOT NULL,
  vendor        text,
  quantity      numeric(14,4) NOT NULL CHECK (quantity > 0),
  unit_cost     numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  total_cost    numeric(14,4) NOT NULL CHECK (total_cost >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  receipt_id    uuid REFERENCES receipts(id) ON DELETE SET NULL,
  pack_size     numeric(14,4) NOT NULL DEFAULT 1 CHECK (pack_size > 0)
);
CREATE INDEX ingredient_purchases_latest ON ingredient_purchases (ingredient_id, purchase_date DESC, created_at DESC);
CREATE INDEX ingredient_purchases_receipt ON ingredient_purchases (receipt_id);

-- The lines extracted from a receipt's JSON, kept so lines skipped during review can
-- be saved later. purchase_id is set once a line is saved; deleting that purchase puts
-- the line back to unsaved.
CREATE TABLE receipt_lines (
  receipt_id  uuid NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  position    integer NOT NULL,
  name        text NOT NULL,
  category    text,
  quantity    numeric(14,4) NOT NULL,
  unit        text,
  unit_cost   numeric(14,4),
  total_cost  numeric(14,4),
  note        text,
  purchase_id uuid UNIQUE REFERENCES ingredient_purchases(id) ON DELETE SET NULL,
  PRIMARY KEY (receipt_id, position)
);

-- Spice Lab: blends of spices measured in kitchen units (pinch, tsp, tbsp, g, oz…).
-- servings is how many servings one batch covers; the Spice Lab scales a batch from it.
CREATE TABLE spice_blends (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  servings   integer NOT NULL DEFAULT 1 CHECK (servings > 0)
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

-- target_margin keeps 6 decimals so a margin derived from a typed target price reproduces
-- that price to the cent.
CREATE TABLE recipes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  base_servings integer NOT NULL CHECK (base_servings > 0),
  total_yield   numeric(14,4),
  yield_unit    text,
  target_margin numeric(9,6) NOT NULL DEFAULT 70 CHECK (target_margin >= 0 AND target_margin < 100),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- A recipe line is an ingredient (amount in its UOM) or a whole blend (amount in tsp).
CREATE TABLE recipe_ingredients (
  recipe_id     uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position      integer NOT NULL,
  ingredient_id uuid REFERENCES ingredients(id) ON DELETE RESTRICT,
  amount        numeric(14,4) NOT NULL CHECK (amount >= 0),
  blend_id      uuid REFERENCES spice_blends(id) ON DELETE RESTRICT,
  PRIMARY KEY (recipe_id, position),
  CONSTRAINT recipe_ingredients_one_item CHECK (num_nonnulls(ingredient_id, blend_id) = 1)
);
CREATE INDEX recipe_ingredients_ingredient ON recipe_ingredients (ingredient_id);
CREATE INDEX recipe_ingredients_blend ON recipe_ingredients (blend_id);

CREATE TABLE events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  event_date  date NOT NULL,
  guest_count integer CHECK (guest_count >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_recipes (
  event_id          uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  recipe_id         uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  expected_servings integer NOT NULL CHECK (expected_servings >= 0),
  PRIMARY KEY (event_id, recipe_id)
);

-- Per-event "needed" amounts set by hand on the shopping list (used for labor, which
-- doesn't scale with servings the way ingredients do). Overrides the scaled recipe total.
CREATE TABLE event_amounts (
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  amount        numeric(14,4) NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (event_id, ingredient_id)
);

-- Image files live in UPLOAD_DIR; each row belongs to exactly one recipe or receipt.
CREATE TABLE images (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id     uuid REFERENCES recipes(id) ON DELETE CASCADE,
  receipt_id    uuid REFERENCES receipts(id) ON DELETE CASCADE,
  filename      text NOT NULL UNIQUE,
  mime          text NOT NULL,
  size_bytes    integer NOT NULL,
  original_name text,
  position      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(recipe_id, receipt_id) = 1)
);
CREATE INDEX images_recipe ON images (recipe_id, position);
CREATE INDEX images_receipt ON images (receipt_id, position);
