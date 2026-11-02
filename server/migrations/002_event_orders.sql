-- A recorded sale is also an order: who it's for and where it is in the queue. Sales from before
-- this, and those counted with Record sales, were handed over on the spot, so they're completed.
-- A cancelled order stays listed but counts toward nothing.
ALTER TABLE event_sales
  ADD COLUMN customer_name     text,
  ADD COLUMN status            text NOT NULL DEFAULT 'completed' CHECK (status IN ('placed', 'in_progress', 'completed', 'cancelled')),
  ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now();
UPDATE event_sales SET status_changed_at = created_at;
