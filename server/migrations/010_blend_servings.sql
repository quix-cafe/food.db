-- How many servings one batch of a blend covers; the Spice Lab scales a batch from it.
ALTER TABLE spice_blends ADD COLUMN servings integer NOT NULL DEFAULT 1 CHECK (servings > 0);
