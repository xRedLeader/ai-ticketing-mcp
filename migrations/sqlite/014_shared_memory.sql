CREATE TABLE knowledge_promotions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source_project_id TEXT NOT NULL REFERENCES projects(id),
  source_knowledge_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision>0),
  fact TEXT NOT NULL CHECK(json_valid(fact) AND json_type(fact)='object'),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  withdrawn_by TEXT REFERENCES actors(id),
  withdrawn_at TEXT,
  CHECK(project_id<>source_project_id),
  CHECK((withdrawn_by IS NULL)=(withdrawn_at IS NULL)),
  FOREIGN KEY(source_project_id,source_knowledge_id,source_revision) REFERENCES knowledge_revisions(project_id,knowledge_id,revision)
);
CREATE INDEX knowledge_promotions_project ON knowledge_promotions(project_id,created_at,id);
CREATE TRIGGER knowledge_promotion_no_delete BEFORE DELETE ON knowledge_promotions BEGIN SELECT RAISE(ABORT,'Promotion audit cannot be deleted'); END;
CREATE TRIGGER knowledge_promotion_withdraw_only BEFORE UPDATE ON knowledge_promotions WHEN
  OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL OR
  NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.source_project_id IS NOT OLD.source_project_id OR
  NEW.source_knowledge_id IS NOT OLD.source_knowledge_id OR NEW.source_revision IS NOT OLD.source_revision OR
  NEW.fact IS NOT OLD.fact OR NEW.actor_id IS NOT OLD.actor_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'Only first withdrawal may update promotion audit'); END;
