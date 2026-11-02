-- Counts saves of an event's plan. A save names the version it was edited from and is refused if the
-- event has moved on, so a window holding an old copy can't write that copy over newer work.
ALTER TABLE events ADD COLUMN version integer NOT NULL DEFAULT 1;
