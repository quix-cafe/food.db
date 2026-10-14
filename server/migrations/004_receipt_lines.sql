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

-- Receipts saved before this migration get their lines extracted on first view.
ALTER TABLE receipts ADD COLUMN lines_extracted boolean NOT NULL DEFAULT false;
