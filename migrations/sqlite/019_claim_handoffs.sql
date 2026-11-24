CREATE TABLE claim_handoffs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  source_actor_id TEXT NOT NULL REFERENCES actors(id),
  recipient_id TEXT NOT NULL REFERENCES actors(id),
  source_claim_hash TEXT NOT NULL CHECK(length(source_claim_hash)=64 AND source_claim_hash NOT GLOB '*[^a-f0-9]*'),
  requirements_revision INTEGER NOT NULL CHECK(requirements_revision > 0),
  ticket_revision INTEGER NOT NULL CHECK(ticket_revision > 0),
  FOREIGN KEY(project_id,ticket_id) REFERENCES tickets(project_id,id),
  FOREIGN KEY(project_id,ticket_id,id) REFERENCES notes(project_id,ticket_id,id),
  CHECK(source_actor_id <> recipient_id)
);
CREATE INDEX claim_handoffs_ticket ON claim_handoffs(project_id,ticket_id);
CREATE TRIGGER claim_handoff_immutable_update BEFORE UPDATE ON claim_handoffs BEGIN SELECT RAISE(ABORT,'Claim handoff is immutable'); END;
CREATE TRIGGER claim_handoff_immutable_delete BEFORE DELETE ON claim_handoffs BEGIN SELECT RAISE(ABORT,'Claim handoff is immutable'); END;
