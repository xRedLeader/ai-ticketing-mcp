CREATE TABLE milestones (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL CHECK(length(trim(name))>0),
  outcome text NOT NULL CHECK(length(trim(outcome))>0),
  exit_criteria jsonb NOT NULL CHECK(jsonb_typeof(exit_criteria)='array' AND jsonb_array_length(exit_criteria)>0),
  revision integer NOT NULL CHECK(revision>0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  completed_by uuid REFERENCES actors(id),
  CHECK((completed_at IS NULL)=(completed_by IS NULL)),
  UNIQUE(project_id,id)
);
CREATE INDEX milestones_project ON milestones(project_id,created_at,id);
CREATE TABLE milestone_memberships (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  milestone_id uuid NOT NULL,
  FOREIGN KEY(project_id,id) REFERENCES tickets(project_id,id),
  FOREIGN KEY(project_id,milestone_id) REFERENCES milestones(project_id,id)
);
CREATE INDEX milestone_memberships_page ON milestone_memberships(project_id,milestone_id,id);
