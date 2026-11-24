CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL CHECK(length(trim(name))>0),
  outcome TEXT NOT NULL CHECK(length(trim(outcome))>0),
  exit_criteria TEXT NOT NULL CHECK(json_valid(exit_criteria) AND json_type(exit_criteria)='array' AND json_array_length(exit_criteria)>0),
  revision INTEGER NOT NULL CHECK(revision>0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  completed_by TEXT REFERENCES actors(id),
  CHECK((completed_at IS NULL)=(completed_by IS NULL)),
  UNIQUE(project_id,id)
);
CREATE INDEX milestones_project ON milestones(project_id,created_at,id);
CREATE TABLE milestone_memberships (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  FOREIGN KEY(project_id,id) REFERENCES tickets(project_id,id),
  FOREIGN KEY(project_id,milestone_id) REFERENCES milestones(project_id,id)
);
CREATE INDEX milestone_memberships_page ON milestone_memberships(project_id,milestone_id,id);
