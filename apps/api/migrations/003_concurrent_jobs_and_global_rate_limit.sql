-- Bonus scope: preserve every existing job while removing only the
-- single-active-job restriction.
DROP INDEX IF EXISTS jobs_single_active_idx;

ALTER TABLE jobs
  ADD COLUMN scheduler_last_claimed_at timestamptz;

CREATE INDEX jobs_active_scheduler_idx
  ON jobs (scheduler_last_claimed_at NULLS FIRST, created_at, id)
  WHERE status IN ('queued', 'running');

-- One durable row coordinates request-start reservations and provider
-- cooldowns across every API/worker process using this database.
CREATE TABLE enrichment_rate_limit (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  next_start_at timestamptz NOT NULL DEFAULT '-infinity',
  cooldown_until timestamptz NOT NULL DEFAULT '-infinity',
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO enrichment_rate_limit (singleton) VALUES (true);
