CREATE TABLE artifact_retirements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at <= requested_at),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 16777216),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  root_identity TEXT NOT NULL,
  file_identity TEXT NOT NULL,
  FOREIGN KEY(project_id,run_id,attempt_id) REFERENCES execution_attempts(project_id,run_id,id),
  FOREIGN KEY(project_id,ticket_id,checkpoint_id) REFERENCES notes(project_id,ticket_id,id)
);
CREATE INDEX artifact_retirements_run ON artifact_retirements(run_id);
CREATE INDEX artifact_retirements_attempt ON artifact_retirements(attempt_id);
CREATE INDEX artifact_retirements_ticket ON artifact_retirements(ticket_id);
CREATE INDEX artifact_retirements_checkpoint ON artifact_retirements(checkpoint_id);
CREATE TRIGGER artifact_retirement_immutable_update BEFORE UPDATE ON artifact_retirements BEGIN SELECT RAISE(ABORT,'Artifact retirement is immutable'); END;
CREATE TRIGGER artifact_retirement_immutable_delete BEFORE DELETE ON artifact_retirements BEGIN SELECT RAISE(ABORT,'Artifact retirement is immutable'); END;
