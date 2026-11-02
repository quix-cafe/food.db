-- What one serving of a recipe is at this event, in the recipe's yield unit ("3" tacos). Null: the
-- recipe's own size (total_yield / base_servings). Cost, default price and shopping amounts scale with it.
ALTER TABLE event_recipes ADD COLUMN serving_size numeric(12,4) CHECK (serving_size > 0);
