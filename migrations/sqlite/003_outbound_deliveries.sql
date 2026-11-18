CREATE UNIQUE INDEX events_project_identity ON events(project_id,id);
CREATE TABLE outbound_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK(json_valid(body) AND json_type(body)='object'),
  target_fingerprint TEXT NOT NULL CHECK(length(target_fingerprint)=64 AND target_fingerprint NOT GLOB '*[^0-9a-f]*'),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 2147483647),
  next_attempt_at TEXT NOT NULL,
  locked_until TEXT,
  lock_token TEXT,
  sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id,event_id) REFERENCES events(project_id,id),
  UNIQUE(event_id,target_fingerprint)
);
CREATE INDEX outbound_deliveries_due ON outbound_deliveries(target_fingerprint,sent_at,next_attempt_at,locked_until);
