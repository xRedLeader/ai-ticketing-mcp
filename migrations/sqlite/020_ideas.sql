CREATE TABLE ideas (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  problem TEXT NOT NULL,
  proposal TEXT NOT NULL,
  why TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('submitted','parked','declined','promoted')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_by TEXT NOT NULL REFERENCES actors(id),
  decided_by TEXT REFERENCES actors(id),
  rationale TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id,id),
  CHECK((status='submitted' AND decided_by IS NULL AND rationale IS NULL) OR
    (status<>'submitted' AND decided_by IS NOT NULL AND rationale IS NOT NULL AND length(trim(rationale)) > 0))
);
CREATE INDEX ideas_project_page ON ideas(project_id,created_at DESC,id);
CREATE TABLE idea_tickets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  idea_id TEXT NOT NULL,
  idea_revision INTEGER NOT NULL CHECK(idea_revision > 0),
  ticket_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY(project_id,idea_id) REFERENCES ideas(project_id,id),
  FOREIGN KEY(project_id,ticket_id) REFERENCES tickets(project_id,id)
);
CREATE INDEX idea_tickets_idea ON idea_tickets(project_id,idea_id);
CREATE TRIGGER idea_ticket_immutable_update BEFORE UPDATE ON idea_tickets BEGIN SELECT RAISE(ABORT,'Idea provenance is immutable'); END;
CREATE TRIGGER idea_ticket_immutable_delete BEFORE DELETE ON idea_tickets BEGIN SELECT RAISE(ABORT,'Idea provenance is immutable'); END;
