ALTER TABLE knowledge RENAME TO knowledge_legacy;
CREATE TABLE knowledge (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('policy','decision','convention','pitfall','runbook','architecture','note')),
  sources TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(sources) AND json_type(sources)='array'),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','accepted')),
  verification TEXT NOT NULL DEFAULT '{"state":"unverified"}' CHECK(json_valid(verification) AND json_type(verification)='object' AND json_extract(verification,'$.state') IS NOT NULL AND json_extract(verification,'$.state') IN ('unverified','verified')),
  revision INTEGER NOT NULL CHECK(revision>0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  updated_at TEXT NOT NULL,
  UNIQUE(project_id,id),
  CHECK(status<>'accepted' OR (json_extract(verification,'$.state')='verified' AND json_array_length(sources)>0))
);
INSERT INTO knowledge(id,project_id,title,body,kind,revision,archived,actor_id,updated_at)
SELECT id,project_id,title,body,kind,revision,archived,actor_id,updated_at FROM knowledge_legacy;
DROP TABLE knowledge_legacy;
CREATE INDEX knowledge_project ON knowledge(project_id,archived,id);
CREATE TABLE knowledge_revisions (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('policy','decision','convention','pitfall','runbook','architecture','note')),
  sources TEXT NOT NULL CHECK(json_valid(sources) AND json_type(sources)='array'),
  status TEXT NOT NULL CHECK(status IN ('proposed','accepted')),
  verification TEXT NOT NULL CHECK(json_valid(verification) AND json_type(verification)='object' AND json_extract(verification,'$.state') IS NOT NULL AND json_extract(verification,'$.state') IN ('unverified','verified')),
  revision INTEGER NOT NULL CHECK(revision>0),
  archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id,knowledge_id) REFERENCES knowledge(project_id,id),
  UNIQUE(project_id,knowledge_id,revision),
  CHECK(id=knowledge_id||':'||revision),
  CHECK(status<>'accepted' OR (json_extract(verification,'$.state')='verified' AND json_array_length(sources)>0))
);
INSERT INTO knowledge_revisions(id,knowledge_id,project_id,title,body,kind,sources,status,verification,revision,archived,actor_id,updated_at)
SELECT id||':'||revision,id,project_id,title,body,kind,sources,status,verification,revision,archived,actor_id,updated_at FROM knowledge;
CREATE TRIGGER knowledge_revision_no_update BEFORE UPDATE ON knowledge_revisions BEGIN SELECT RAISE(ABORT,'Knowledge revisions are immutable'); END;
CREATE TRIGGER knowledge_revision_no_delete BEFORE DELETE ON knowledge_revisions BEGIN SELECT RAISE(ABORT,'Knowledge revisions are immutable'); END;
