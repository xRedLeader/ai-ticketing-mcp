CREATE TABLE artifact_retirements (
  id text PRIMARY KEY CHECK(id ~ '^execution:[0-9a-f-]{36}:[0-9a-f-]{36}:(stdout|stderr)$'),
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  checkpoint_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES actors(id),
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at <= requested_at),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 0 AND 16777216),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  root_identity text NOT NULL,
  file_identity text NOT NULL,
  FOREIGN KEY(project_id,run_id,attempt_id) REFERENCES execution_attempts(project_id,run_id,id),
  FOREIGN KEY(project_id,ticket_id,checkpoint_id) REFERENCES notes(project_id,ticket_id,id)
);
CREATE INDEX artifact_retirements_run ON artifact_retirements(run_id);
CREATE INDEX artifact_retirements_attempt ON artifact_retirements(attempt_id);
CREATE INDEX artifact_retirements_ticket ON artifact_retirements(ticket_id);
CREATE INDEX artifact_retirements_checkpoint ON artifact_retirements(checkpoint_id);
CREATE TRIGGER artifact_retirement_immutable BEFORE UPDATE OR DELETE ON artifact_retirements FOR EACH ROW EXECUTE FUNCTION immutable_execution_history();
