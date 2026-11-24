ALTER TABLE knowledge ADD COLUMN fact jsonb NOT NULL DEFAULT 'null' CHECK(fact='null'::jsonb OR jsonb_typeof(fact)='object');
ALTER TABLE knowledge ADD COLUMN expires_at timestamptz;
ALTER TABLE knowledge ADD COLUMN supersedes jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(supersedes)='array');
ALTER TABLE knowledge_revisions ADD COLUMN fact jsonb NOT NULL DEFAULT 'null' CHECK(fact='null'::jsonb OR jsonb_typeof(fact)='object');
ALTER TABLE knowledge_revisions ADD COLUMN expires_at timestamptz;
ALTER TABLE knowledge_revisions ADD COLUMN supersedes jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(supersedes)='array');
