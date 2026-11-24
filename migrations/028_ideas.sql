CREATE TABLE ideas (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  title text NOT NULL,
  problem text NOT NULL,
  proposal text NOT NULL,
  why text NOT NULL,
  status text NOT NULL CHECK(status IN ('submitted','parked','declined','promoted')),
  revision integer NOT NULL CHECK(revision > 0),
  created_by uuid NOT NULL REFERENCES actors(id),
  decided_by uuid REFERENCES actors(id),
  rationale text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(project_id,id),
  CHECK((status='submitted' AND decided_by IS NULL AND rationale IS NULL) OR
    (status<>'submitted' AND decided_by IS NOT NULL AND rationale IS NOT NULL AND length(trim(rationale)) > 0))
);
CREATE INDEX ideas_project_page ON ideas(project_id,created_at DESC,id);
CREATE TABLE idea_tickets (
  id text PRIMARY KEY,
  project_id uuid NOT NULL,
  idea_id uuid NOT NULL,
  idea_revision integer NOT NULL CHECK(idea_revision > 0),
  ticket_id uuid NOT NULL UNIQUE,
  FOREIGN KEY(project_id,idea_id) REFERENCES ideas(project_id,id),
  FOREIGN KEY(project_id,ticket_id) REFERENCES tickets(project_id,id)
);
CREATE INDEX idea_tickets_idea ON idea_tickets(project_id,idea_id);
CREATE TRIGGER idea_ticket_immutable BEFORE UPDATE OR DELETE ON idea_tickets FOR EACH ROW EXECUTE FUNCTION immutable_execution_history();
