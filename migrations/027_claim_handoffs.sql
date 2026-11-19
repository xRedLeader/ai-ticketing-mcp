CREATE TABLE claim_handoffs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  source_actor_id uuid NOT NULL REFERENCES actors(id),
  recipient_id uuid NOT NULL REFERENCES actors(id),
  source_claim_hash text NOT NULL CHECK(source_claim_hash ~ '^[a-f0-9]{64}$'),
  requirements_revision integer NOT NULL CHECK(requirements_revision > 0),
  ticket_revision integer NOT NULL CHECK(ticket_revision > 0),
  FOREIGN KEY(project_id,ticket_id) REFERENCES tickets(project_id,id),
  FOREIGN KEY(project_id,ticket_id,id) REFERENCES notes(project_id,ticket_id,id),
  CHECK(source_actor_id <> recipient_id)
);
CREATE INDEX claim_handoffs_ticket ON claim_handoffs(project_id,ticket_id);
CREATE TRIGGER claim_handoff_immutable BEFORE UPDATE OR DELETE ON claim_handoffs FOR EACH ROW EXECUTE FUNCTION immutable_execution_history();
