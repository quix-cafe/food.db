-- Test data: rows created while the app is in test mode are marked is_test so they can be
-- cleared later in one go. The default reads a per-transaction setting the server turns on
-- for test-mode requests (db.js), so no INSERT needs to mention the column.
CREATE FUNCTION is_test_default() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT coalesce(nullif(current_setting('app.test_data', true), ''), 'off')::boolean $$;

ALTER TABLE ingredients          ADD COLUMN is_test boolean NOT NULL DEFAULT is_test_default();
ALTER TABLE ingredient_purchases ADD COLUMN is_test boolean NOT NULL DEFAULT is_test_default();
ALTER TABLE receipts             ADD COLUMN is_test boolean NOT NULL DEFAULT is_test_default();
ALTER TABLE recipes              ADD COLUMN is_test boolean NOT NULL DEFAULT is_test_default();
ALTER TABLE events               ADD COLUMN is_test boolean NOT NULL DEFAULT is_test_default();
ALTER TABLE spice_blends         ADD COLUMN is_test boolean NOT NULL DEFAULT is_test_default();
