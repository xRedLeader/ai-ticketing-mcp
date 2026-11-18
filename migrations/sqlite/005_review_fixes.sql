CREATE INDEX members_actor ON members(actor_id,id);
CREATE INDEX receipts_created ON receipts(created_at);
-- Reset old document revisions before indexing ticket requirements revisions.
DELETE FROM search_documents WHERE kind='ticket';
INSERT INTO jobs(id,project_id,entity_id,kind,revision,attempts,available_at)
SELECT 'ticket:'||id,project_id,id,'ticket',requirements_revision,0,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tickets WHERE 1
ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,attempts=0,available_at=excluded.available_at,locked_until=NULL,lock_token=NULL,last_error=NULL;
