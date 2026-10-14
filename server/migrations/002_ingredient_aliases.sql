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
