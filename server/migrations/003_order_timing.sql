-- When an order was started and finished; created_at is when it was placed. A sale handed over on
-- the spot has neither, so it stays out of the timings. Older orders only know their last change.
ALTER TABLE event_sales
  ADD COLUMN in_progress_at timestamptz,
  ADD COLUMN completed_at   timestamptz;
UPDATE event_sales SET in_progress_at = status_changed_at WHERE status = 'in_progress';
UPDATE event_sales SET completed_at = status_changed_at WHERE status = 'completed' AND status_changed_at > created_at;
