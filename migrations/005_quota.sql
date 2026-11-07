-- Quota as the agents themselves report it. Only observed samples are stored; nothing is estimated.
CREATE TABLE IF NOT EXISTS quota_samples (
  provider VARCHAR NOT NULL,
  window_kind VARCHAR NOT NULL,
  sampled_at VARCHAR NOT NULL,
  used_percent DOUBLE,
  reset_at VARCHAR,
  window_minutes INTEGER,
  plan VARCHAR,
  source VARCHAR NOT NULL,
  PRIMARY KEY (provider, window_kind, sampled_at)
);
-- Moments a provider refused work because a limit was reached.
CREATE TABLE IF NOT EXISTS quota_events (
  provider VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  happened_at VARCHAR NOT NULL,
  window_kind VARCHAR,
  reset_at VARCHAR,
  source VARCHAR NOT NULL,
  PRIMARY KEY (provider, kind, happened_at)
);
