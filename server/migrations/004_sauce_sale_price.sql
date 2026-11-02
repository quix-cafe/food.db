-- A sauce's own price per serving, as a recipe has target_price. Null: its cost at the default
-- margin. An event's event_blends.sale_price still takes priority.
ALTER TABLE spice_blends ADD COLUMN sale_price numeric(12,2) CHECK (sale_price >= 0);
