-- After the event: what actually happened, recorded by hand and compared with the plan.
-- actual_cost is what was spent; when it's blank the comparison uses the projected cost.
ALTER TABLE events
  ADD COLUMN actual_guests  integer CHECK (actual_guests >= 0),
  ADD COLUMN actual_revenue numeric(14,2) CHECK (actual_revenue >= 0),
  ADD COLUMN actual_cost    numeric(14,2) CHECK (actual_cost >= 0),
  ADD COLUMN notes          text;
