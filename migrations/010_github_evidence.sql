ALTER TABLE tickets ADD COLUMN github_pull_request jsonb;

CREATE TABLE github_evidence (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  actor_id uuid NOT NULL REFERENCES actors(id),
  repository text NOT NULL,
  pull_request_number integer NOT NULL CHECK (pull_request_number > 0),
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  observed_head_sha text NOT NULL CHECK (observed_head_sha ~ '^[a-f0-9]{40}$'),
  status text NOT NULL CHECK (status IN ('passed','pending','failed','missing','stale')),
  requirements_revision integer NOT NULL CHECK (requirements_revision > 0),
  ticket_revision integer NOT NULL CHECK (ticket_revision > 0),
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  observed_at timestamptz NOT NULL
);
CREATE INDEX github_evidence_history ON github_evidence(project_id,ticket_id,ticket_revision DESC,id DESC);
