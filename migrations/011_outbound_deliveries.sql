CREATE UNIQUE INDEX events_project_identity ON events(project_id,id);
CREATE TABLE outbound_deliveries (
  id uuid PRIMARY KEY,
  event_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  body text NOT NULL CHECK (jsonb_typeof(body::jsonb) = 'object'),
  target_fingerprint text NOT NULL CHECK (target_fingerprint ~ '^[a-f0-9]{64}$'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL,
  locked_until timestamptz,
  lock_token uuid,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL,
  FOREIGN KEY(project_id,event_id) REFERENCES events(project_id,id),
  UNIQUE(event_id,target_fingerprint)
);
CREATE INDEX outbound_deliveries_due ON outbound_deliveries(target_fingerprint,sent_at,next_attempt_at,locked_until);
