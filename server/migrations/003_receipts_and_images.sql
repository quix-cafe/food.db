-- A saved receipt: where purchases came from, with the extractor's JSON and photos.
CREATE TABLE receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor       text,
  receipt_date date,
  source       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Deleting a receipt keeps its purchases; they are price history.
ALTER TABLE ingredient_purchases ADD COLUMN receipt_id uuid REFERENCES receipts(id) ON DELETE SET NULL;
CREATE INDEX ingredient_purchases_receipt ON ingredient_purchases (receipt_id);

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
