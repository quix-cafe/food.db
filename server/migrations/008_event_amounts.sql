-- Per-event "needed" amounts set by hand on the shopping list (used for labor, which
-- doesn't scale with servings the way ingredients do). Overrides the scaled recipe total.
CREATE TABLE event_amounts (
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  amount        numeric(14,4) NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (event_id, ingredient_id)
);
