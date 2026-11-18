ALTER TABLE tickets ADD COLUMN github_pull_request TEXT
  CHECK(github_pull_request IS NULL OR (json_valid(github_pull_request) AND json_type(github_pull_request)='object'));
CREATE TABLE github_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  repository TEXT NOT NULL,
  pull_request_number INTEGER NOT NULL CHECK(pull_request_number>0),
  head_sha TEXT,
  observed_head_sha TEXT,
  status TEXT NOT NULL CHECK(status IN ('passed','pending','failed','missing','stale')),
  requirements_revision INTEGER NOT NULL CHECK(requirements_revision>0),
  ticket_revision INTEGER NOT NULL CHECK(ticket_revision>0),
  checks TEXT NOT NULL CHECK(json_valid(checks) AND json_type(checks)='array'),
  observed_at TEXT NOT NULL,
  FOREIGN KEY(project_id,ticket_id) REFERENCES tickets(project_id,id)
);
CREATE INDEX github_evidence_ticket ON github_evidence(project_id,ticket_id,ticket_revision DESC,id DESC);
