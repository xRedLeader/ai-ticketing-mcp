import type { ArtifactPinQuery } from '../contracts.js';

/** Plain-text citations are intentionally conservative; historical evidence/memory also pins. */
export function artifactPinSql(
  query: ArtifactPinQuery,
  bind: (value: string) => string,
  tables: readonly string[] = [],
) {
  const contains = (expression: string, ids = [query.run_id, query.attempt_id]) =>
    ids.map((id) => `LOWER(${expression}) LIKE ${bind(`%${id}%`)}`).join(' OR ');
  const checks = [
    `EXISTS(SELECT 1 FROM tickets WHERE id=${bind(query.ticket_id)} AND status NOT IN ('done','cancelled'))`,
    ...[
      ['projects', 'instructions'],
      ...(tables.includes('ideas')
        ? [['ideas', "title || problem || proposal || why || COALESCE(rationale,'')"]]
        : []),
      ...(tables.includes('milestones')
        ? [['milestones', 'name || outcome || CAST(exit_criteria AS TEXT)']]
        : []),
      ['tickets', 'title || description || CAST(labels AS TEXT) || CAST(capabilities AS TEXT)'],
      ['criteria', 'text'],
      ['notes', 'body || CAST(metadata AS TEXT)'],
      [
        'submissions',
        "summary || CAST(evidence AS TEXT) || COALESCE(CAST(requirements_snapshot AS TEXT),'')",
      ],
      ['reviews', 'feedback'],
      ['execution_cancellations', "COALESCE(reconciliation_note,'')"],
      ['knowledge', "title || body || CAST(verification AS TEXT) || COALESCE(CAST(fact AS TEXT),'')"],
      [
        'knowledge_revisions',
        "title || body || CAST(verification AS TEXT) || COALESCE(CAST(fact AS TEXT),'')",
      ],
    ].map(([table, expression]) => `EXISTS(SELECT 1 FROM ${table} WHERE ${contains(expression!)})`),
    ...['knowledge', 'knowledge_revisions'].map(
      (table) =>
        `EXISTS(SELECT 1 FROM ${table} WHERE ${contains('CAST(sources AS TEXT)', [query.ticket_id, query.checkpoint_id])})`,
    ),
    `EXISTS(SELECT 1 FROM receipts WHERE operation NOT IN ('run_submit','run_cancel') AND (${contains('CAST(result AS TEXT)')}))`,
    `EXISTS(SELECT 1 FROM events WHERE type NOT LIKE 'run.%' AND type NOT LIKE 'artifact.%' AND (${contains('CAST(data AS TEXT)')}))`,
  ];
  return `SELECT ${checks.join(' OR ')} AS pinned`;
}
