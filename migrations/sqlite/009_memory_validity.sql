ALTER TABLE knowledge ADD COLUMN fact TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(fact) AND json_type(fact) IN ('null','object'));
ALTER TABLE knowledge ADD COLUMN expires_at TEXT;
ALTER TABLE knowledge ADD COLUMN supersedes TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(supersedes) AND json_type(supersedes)='array');
ALTER TABLE knowledge_revisions ADD COLUMN fact TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(fact) AND json_type(fact) IN ('null','object'));
ALTER TABLE knowledge_revisions ADD COLUMN expires_at TEXT;
ALTER TABLE knowledge_revisions ADD COLUMN supersedes TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(supersedes) AND json_type(supersedes)='array');
