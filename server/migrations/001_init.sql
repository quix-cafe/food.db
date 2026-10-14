CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Master ingredient record; the "Asset ID" is the UUID primary key.
CREATE TABLE ingredients (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  category              text,
  default_yield_percent numeric(7,3) NOT NULL DEFAULT 100
                        CHECK (default_yield_percent > 0 AND default_yield_percent <= 100),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ingredients_name_key ON ingredients (lower(name));
CREATE INDEX ingredients_name_trgm ON ingredients USING gin (name gin_trgm_ops);

-- Append-only price history: new purchases never overwrite earlier unit costs.
CREATE TABLE ingredient_purchases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  purchase_date date NOT NULL,
  vendor        text,
  quantity      numeric(14,4) NOT NULL CHECK (quantity > 0),
  weight        numeric(14,4),
  unit          text,
  unit_cost     numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  total_cost    numeric(14,4) NOT NULL CHECK (total_cost >= 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingredient_purchases_latest ON ingredient_purchases (ingredient_id, purchase_date DESC, created_at DESC);

CREATE TABLE recipes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  base_servings integer NOT NULL CHECK (base_servings > 0),
  total_yield   numeric(14,4),
  yield_unit    text,
  target_margin numeric(5,2) NOT NULL DEFAULT 70 CHECK (target_margin >= 0 AND target_margin < 100),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recipe_ingredients (
  recipe_id     uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position      integer NOT NULL,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  use_percent   numeric(7,3) NOT NULL DEFAULT 100 CHECK (use_percent >= 0 AND use_percent <= 100),
  base_quantity numeric(14,4) NOT NULL CHECK (base_quantity >= 0),
  PRIMARY KEY (recipe_id, position)
);
CREATE INDEX recipe_ingredients_ingredient ON recipe_ingredients (ingredient_id);

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
