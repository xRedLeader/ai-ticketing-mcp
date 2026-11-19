import type { Knowledge, KnowledgeRevision, MemoryValidity, Reader } from './contracts.js';

/** Evaluate provenance from one authorized database snapshot, never from the search index. */
export async function inspectMemory(reader: Reader, projectId: string, now: string) {
  // shortcut: bound project scans at 1,000 rows; add indexed fact/supersession queries before raising this limit.
  const documents = await reader.find('knowledge', { where: { project_id: projectId }, limit: 1001 });
  const history = await reader.find('knowledge_revisions', {
    where: { project_id: projectId, status: 'accepted' },
    limit: 1001,
  });
  if (documents.length > 1000 || history.length > 1000)
    return async (_document: Knowledge) => ({
      validity: 'unavailable' as const,
      trusted_reuse: false,
      contradictions: [],
    });
  const byId = new Map(documents.map((item) => [item.id, item]));
  const superseded = new Set<string>();
  for (const revision of history)
    for (const target of revision.supersedes) superseded.add(`${target.id}:${target.revision}`);
  const states = new Map<string, MemoryValidity>();
  async function state(document: Knowledge, path = new Set<string>()): Promise<MemoryValidity> {
    const id = 'knowledge_id' in document ? (document as KnowledgeRevision).knowledge_id : document.id;
    const key = `${id}:${document.revision}`;
    const cached = states.get(key);
    if (cached) return cached;
    if (path.has(key)) return 'stale';
    let result: MemoryValidity = 'current';
    if (document.archived || byId.get(id)?.archived) result = 'archived';
    else if (byId.get(id)?.revision !== document.revision) result = 'stale';
    else if (document.expires_at && Date.parse(document.expires_at) <= Date.parse(now)) result = 'expired';
    else if (superseded.has(key)) result = 'superseded';
    else {
      const next = new Set(path).add(key);
      for (const source of document.sources) {
        if (source.kind === 'knowledge') {
          const supporting = byId.get(source.id);
          if (
            !supporting ||
            supporting.revision !== source.revision ||
            (await state(supporting, next)) !== 'current'
          ) {
            result = 'stale';
            break;
          }
        } else {
          const note = source.kind === 'checkpoint' ? await reader.get('notes', source.id) : null;
          const ticket = await reader.get('tickets', note?.ticket_id ?? source.id);
          if (
            !ticket ||
            ticket.project_id !== projectId ||
            ticket.status === 'cancelled' ||
            (source.kind === 'ticket'
              ? ticket.requirements_revision !== source.revision
              : !note ||
                note.project_id !== projectId ||
                note.kind !== 'checkpoint' ||
                note.ticket_revision !== source.revision ||
                note.metadata.requirements_revision !== ticket.requirements_revision)
          ) {
            result = 'stale';
            break;
          }
        }
      }
      if (
        result === 'current' &&
        (document.status !== 'accepted' ||
          document.verification.state !== 'verified' ||
          !document.sources.length ||
          !document.fact)
      )
        result = 'unsupported';
    }
    states.set(key, result);
    return result;
  }
  const conflicts = new Map<string, Knowledge[]>();
  const facts = new Map<string, Knowledge[]>();
  // shortcut: contradictions use exact fact keys/values; add semantic review before reusing unstructured prose.
  for (const document of documents) {
    if (!document.fact || (await state(document)) !== 'current') continue;
    facts.set(document.fact.key, [...(facts.get(document.fact.key) ?? []), document]);
  }
  for (const peers of facts.values())
    for (const document of peers) {
      const others = peers.filter((other) => other.fact!.value !== document.fact!.value);
      if (others.length) conflicts.set(document.id, others);
    }
  function disputes(document: Knowledge, visited = new Set<string>()): Map<string, Knowledge> {
    if (visited.has(document.id)) return new Map();
    visited.add(document.id);
    const peers = conflicts.get(document.id);
    const found = new Map((peers ? [document, ...peers] : []).map((item) => [item.id, item]));
    for (const source of document.sources) {
      const parent = source.kind === 'knowledge' ? byId.get(source.id) : undefined;
      if (parent) for (const [id, item] of disputes(parent, visited)) found.set(id, item);
    }
    return found;
  }
  return async (document: Knowledge) => {
    if ('knowledge_id' in document)
      document = { ...document, id: (document as KnowledgeRevision).knowledge_id };
    let validity = await state(document);
    const conflicting = validity === 'current' ? disputes(document) : new Map<string, Knowledge>();
    if (conflicting.size) validity = 'disputed';
    const contradictions =
      validity === 'disputed'
        ? [...conflicting.values()]
            .filter((other) => other.id !== document.id)
            .map((other) => ({
              knowledge_id: other.id,
              revision: other.revision,
              fact: other.fact!,
              sources: other.sources,
            }))
        : [];
    return { validity, trusted_reuse: validity === 'current', contradictions };
  };
}
