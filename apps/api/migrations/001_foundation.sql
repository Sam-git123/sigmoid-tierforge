CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'completed_with_errors', 'failed')),
  total_stores integer NOT NULL DEFAULT 0 CHECK (total_stores >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  failure_code text,
  failure_reason text,
  CONSTRAINT jobs_lifecycle_check CHECK (
    (status = 'queued' AND started_at IS NULL AND finished_at IS NULL)
    OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (status IN ('completed', 'completed_with_errors', 'failed') AND finished_at IS NOT NULL)
  ),
  CHECK (started_at IS NULL OR started_at >= created_at),
  CHECK (finished_at IS NULL OR finished_at >= COALESCE(started_at, created_at))
);

-- The constant key gives queued AND running jobs one shared active slot.
CREATE UNIQUE INDEX jobs_single_active_idx ON jobs ((1))
  WHERE status IN ('queued', 'running');
CREATE INDEX jobs_created_at_idx ON jobs (created_at DESC);

CREATE TABLE job_stores (
  job_id uuid NOT NULL REFERENCES jobs (id),
  store_id text NOT NULL CHECK (length(btrim(store_id)) > 0),
  store_name text NOT NULL CHECK (length(btrim(store_name)) > 0),
  address text NOT NULL CHECK (length(btrim(address)) > 0),
  city text NOT NULL CHECK (length(btrim(city)) > 0),
  state text NOT NULL CHECK (length(btrim(state)) > 0),
  country text NOT NULL CHECK (length(btrim(country)) > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry_wait', 'succeeded', 'failed', 'skipped')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 6 CHECK (max_attempts > 0),
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, store_id),
  CHECK (attempt_count <= max_attempts),
  CONSTRAINT job_stores_lease_check CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND attempt_count > 0)
    OR (status <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT job_stores_retry_check CHECK (
    (status = 'retry_wait' AND next_attempt_at IS NOT NULL AND attempt_count > 0 AND attempt_count < max_attempts)
    OR (status <> 'retry_wait' AND next_attempt_at IS NULL)
  ),
  CHECK (updated_at >= created_at)
);

CREATE INDEX job_stores_pending_idx ON job_stores (job_id, created_at, store_id)
  WHERE status = 'pending';
CREATE INDEX job_stores_retry_eligible_idx ON job_stores (job_id, next_attempt_at, store_id)
  WHERE status = 'retry_wait';
CREATE INDEX job_stores_expired_lease_idx ON job_stores (job_id, lease_expires_at, store_id)
  WHERE status = 'processing';
CREATE INDEX job_stores_status_idx ON job_stores (job_id, status, store_id);

CREATE TABLE store_enrichments (
  job_id uuid NOT NULL,
  store_id text NOT NULL,
  estimated_monthly_footfall numeric(18,2) NOT NULL
    CHECK (estimated_monthly_footfall >= 0 AND estimated_monthly_footfall <> 'NaN'::numeric),
  estimated_monthly_revenue numeric(18,2) NOT NULL
    CHECK (estimated_monthly_revenue >= 0 AND estimated_monthly_revenue <> 'NaN'::numeric),
  store_size_sqft numeric(18,2) NOT NULL
    CHECK (store_size_sqft >= 0 AND store_size_sqft <> 'NaN'::numeric),
  enriched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, store_id),
  FOREIGN KEY (job_id, store_id) REFERENCES job_stores (job_id, store_id)
);

CREATE TABLE scoring_configs (
  job_id uuid NOT NULL REFERENCES jobs (id),
  footfall_bar numeric(18,2) NOT NULL CHECK (footfall_bar >= 0 AND footfall_bar <> 'NaN'::numeric),
  revenue_bar numeric(18,2) NOT NULL CHECK (revenue_bar >= 0 AND revenue_bar <> 'NaN'::numeric),
  size_bar numeric(18,2) NOT NULL CHECK (size_bar >= 0 AND size_bar <> 'NaN'::numeric),
  footfall_weight numeric(5,2) NOT NULL CHECK (footfall_weight BETWEEN 0 AND 100),
  revenue_weight numeric(5,2) NOT NULL CHECK (revenue_weight BETWEEN 0 AND 100),
  size_weight numeric(5,2) NOT NULL CHECK (size_weight BETWEEN 0 AND 100),
  large_threshold numeric(5,2) NOT NULL CHECK (large_threshold BETWEEN 0 AND 100),
  medium_threshold numeric(5,2) NOT NULL CHECK (medium_threshold BETWEEN 0 AND 100),
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, revision),
  CHECK (footfall_weight + revenue_weight + size_weight = 100),
  CHECK (medium_threshold < large_threshold)
);

CREATE TABLE store_scores (
  job_id uuid NOT NULL,
  store_id text NOT NULL,
  score numeric(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  tier text NOT NULL CHECK (tier IN ('Large', 'Medium', 'Small')),
  config_revision integer NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, store_id, config_revision),
  FOREIGN KEY (job_id, store_id) REFERENCES store_enrichments (job_id, store_id),
  FOREIGN KEY (job_id, config_revision) REFERENCES scoring_configs (job_id, revision)
);

CREATE INDEX store_scores_tier_idx ON store_scores (job_id, config_revision, tier, store_id);

