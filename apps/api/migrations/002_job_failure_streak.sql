ALTER TABLE jobs
  ADD COLUMN provider_failure_streak integer NOT NULL DEFAULT 0
  CHECK (provider_failure_streak >= 0);
