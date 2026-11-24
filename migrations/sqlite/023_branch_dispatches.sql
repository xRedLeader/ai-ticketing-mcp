CREATE TABLE branch_dispatches (
id TEXT PRIMARY KEY,
project_id TEXT NOT NULL REFERENCES projects(id),
actor_id TEXT NOT NULL REFERENCES actors(id),
claim_token TEXT NOT NULL,
requirements_revision INTEGER NOT NULL CHECK(requirements_revision>0),
capacity_id TEXT NOT NULL,
budget_run_id TEXT NOT NULL,
host_id TEXT NOT NULL,
dispatch TEXT NOT NULL CHECK(json_valid(dispatch) AND json_type(dispatch)='object'),
FOREIGN KEY(project_id,id) REFERENCES tickets(project_id,id)
);
