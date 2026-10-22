-- The whole schema as of food.db 1.3 (earlier migrations were combined into this file).
-- Later changes go in new numbered files.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Test data: rows created while the app is in test mode are marked is_test so they can be
-- cleared later in one go. The default reads a per-transaction setting the server turns on
-- for test-mode requests (db.js), so no INSERT needs to mention the column.
CREATE FUNCTION is_test_default() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT coalesce(nullif(current_setting('app.test_data', true), ''), 'off')::boolean $$;

-- Labor (category or name "Labor"/"Labour", as isLabor in shared/src/calc.js) is never test
-- data: it and its rate history survive clearing test data, even if added in test mode.
CREATE FUNCTION is_labor(name text, category text) RETURNS boolean LANGUAGE sql IMMUTABLE
  AS $$ SELECT lower(btrim(coalesce(category, ''))) IN ('labor', 'labour') OR lower(btrim(coalesce(name, ''))) IN ('labor', 'labour') $$;

-- Master ingredient record; the "Asset ID" is the UUID primary key. Each ingredient is
-- measured in one unit of measure (lb, oz, each…): purchases record their store pack size
-- in it, and recipe lines their amount used.
CREATE TABLE ingredients (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  category   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  uom        text NOT NULL DEFAULT 'each',
  is_test    boolean NOT NULL DEFAULT is_test_default()
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

-- Ingredient pairs marked "not the same" in the duplicate suggestions, so they aren't suggested
-- again. One row per pair, smaller id first; deleting either ingredient removes it.
CREATE TABLE ingredient_pair_dismissals (
  ingredient_a uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  ingredient_b uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ingredient_a, ingredient_b),
  CHECK (ingredient_a < ingredient_b)
);
CREATE INDEX ingredient_pair_dismissals_b ON ingredient_pair_dismissals (ingredient_b);

-- A saved receipt: where purchases came from, with the extractor's JSON and photos.
CREATE TABLE receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor       text,
  receipt_date date,
  source       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  is_test      boolean NOT NULL DEFAULT is_test_default()
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
  pack_size     numeric(14,4) NOT NULL DEFAULT 1 CHECK (pack_size > 0),
  is_test       boolean NOT NULL DEFAULT is_test_default()
);
CREATE INDEX ingredient_purchases_latest ON ingredient_purchases (ingredient_id, purchase_date DESC, created_at DESC);
CREATE INDEX ingredient_purchases_receipt ON ingredient_purchases (receipt_id);

CREATE FUNCTION labor_not_test() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'ingredients' THEN
    IF is_labor(NEW.name, NEW.category) THEN NEW.is_test := false; END IF;
  ELSIF EXISTS (SELECT 1 FROM ingredients i WHERE i.id = NEW.ingredient_id AND is_labor(i.name, i.category)) THEN
    NEW.is_test := false;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER labor_not_test BEFORE INSERT OR UPDATE ON ingredients
  FOR EACH ROW EXECUTE FUNCTION labor_not_test();
CREATE TRIGGER labor_not_test BEFORE INSERT OR UPDATE ON ingredient_purchases
  FOR EACH ROW EXECUTE FUNCTION labor_not_test();

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

-- Spice Lab: blends of spices measured in kitchen units (pinch, tsp, tbsp, g, oz, bunch…),
-- and sauces. servings is how many servings one batch covers; the Spice Lab scales a batch
-- from it. A sauce is measured in oz and one batch fills a container (SAUCE_CONTAINERS in
-- shared/src/units.js); a spice blend has no container.
CREATE TABLE spice_blends (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  servings   integer NOT NULL DEFAULT 1 CHECK (servings > 0),
  is_test    boolean NOT NULL DEFAULT is_test_default(),
  kind       text NOT NULL DEFAULT 'spice' CHECK (kind IN ('spice', 'sauce')),
  container  text CHECK (container IN ('1/4 qt', '1/2 qt', '1 qt', '1 gal')),
  CONSTRAINT spice_blends_sauce_container CHECK ((kind = 'sauce') = (container IS NOT NULL))
);

-- A spice is an ingredient from the database (so it can be costed) or just a typed name.
-- A linked one may be measured in its ingredient's own unit ("box").
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
  updated_at    timestamptz NOT NULL DEFAULT now(),
  is_test       boolean NOT NULL DEFAULT is_test_default()
);

-- A recipe line is an ingredient (amount in its UOM) or a whole blend (amount in g; a sauce in oz).
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

-- vendor_fee is what the event charges for a stand, deducted from its profit. The actual_*
-- columns and notes are what happened, recorded by hand after the event and compared with the
-- plan; when actual_cost is blank the comparison uses the projected cost.
CREATE TABLE events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  event_date     date NOT NULL,
  guest_count    integer CHECK (guest_count >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  is_test        boolean NOT NULL DEFAULT is_test_default(),
  actual_guests  integer CHECK (actual_guests >= 0),
  actual_revenue numeric(14,2) CHECK (actual_revenue >= 0),
  actual_cost    numeric(14,2) CHECK (actual_cost >= 0),
  notes          text,
  vendor_fee     numeric(12,2) CHECK (vendor_fee >= 0)
);

-- Per-event pricing for each recipe: a sale price per serving that replaces the recipe's target
-- price (null: use the recipe's), and an optional deal of discount_amount off every discount_qty
-- servings ("buy 2, get $1 off").
CREATE TABLE event_recipes (
  event_id          uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  recipe_id         uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  expected_servings integer NOT NULL CHECK (expected_servings >= 0),
  sale_price        numeric(12,2) CHECK (sale_price >= 0),
  discount_amount   numeric(12,2) CHECK (discount_amount > 0),
  discount_qty      integer CHECK (discount_qty >= 1),
  PRIMARY KEY (event_id, recipe_id),
  CONSTRAINT event_recipes_discount_qty_needs_amount CHECK (discount_qty IS NULL OR discount_amount IS NOT NULL)
);

-- A sauce on an event's menu: `servings` sold by the serving (no deals), made in whole
-- containers of `container` (null: the sauce's own), at sale_price per serving (null: its
-- cost at the default margin). Its ingredients join the shopping list.
CREATE TABLE event_blends (
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  blend_id   uuid NOT NULL REFERENCES spice_blends(id) ON DELETE RESTRICT,
  servings   integer NOT NULL CHECK (servings > 0),
  container  text CHECK (container IN ('1/4 qt', '1/2 qt', '1 qt', '1 gal')),
  sale_price numeric(12,2) CHECK (sale_price >= 0),
  PRIMARY KEY (event_id, blend_id)
);
CREATE INDEX event_blends_blend ON event_blends (blend_id);

-- Per-event "needed" amounts set by hand on the shopping list (used for labor, which
-- doesn't scale with servings the way ingredients do). Overrides the scaled recipe total.
CREATE TABLE event_amounts (
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  amount        numeric(14,4) NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (event_id, ingredient_id)
);

-- Sales recorded during an event, one row per completed line (a customer's items and how they
-- paid, or 'free' for items given away). Each item keeps the recipe's (or sauce's) name and the
-- price and deal used at the time, so later price changes or deletions don't rewrite history.
-- fee is the payment app's fee, charged on top of the items and kept by the app (paymentFee in
-- shared/src/calc.js), stored at the time like the prices.
CREATE TABLE event_sales (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  payment_method text NOT NULL CHECK (payment_method IN ('cash', 'card', 'venmo', 'cashapp', 'free')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  fee            numeric(12,2) NOT NULL DEFAULT 0 CHECK (fee >= 0)
);
CREATE INDEX event_sales_event ON event_sales (event_id, created_at);

-- amount = quantity × unit_price − discount (0 when given away); deals = times the deal applied.
CREATE TABLE event_sale_items (
  sale_id    uuid NOT NULL REFERENCES event_sales(id) ON DELETE CASCADE,
  position   integer NOT NULL,
  recipe_id  uuid REFERENCES recipes(id) ON DELETE SET NULL,
  name       text NOT NULL,
  quantity   integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  deals      integer NOT NULL DEFAULT 0 CHECK (deals >= 0),
  discount   numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  amount     numeric(12,2) NOT NULL CHECK (amount >= 0),
  blend_id   uuid REFERENCES spice_blends(id) ON DELETE SET NULL,
  PRIMARY KEY (sale_id, position)
);
CREATE INDEX event_sale_items_recipe ON event_sale_items (recipe_id);
CREATE INDEX event_sale_items_blend ON event_sale_items (blend_id);

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
