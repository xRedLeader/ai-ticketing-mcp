import { createHash } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/client';
import { DomainError, ensure, type Ticket, type Note } from '../src/contracts.js';
import { serializeSuccessEnvelope } from '../src/envelope.js';
import { artifactResultSchema, type ArtifactResult } from '../src/execution-artifacts.js';
import { resultSchemas } from '../src/result-schemas.js';
import { schemas } from '../src/schemas.js';

type Arguments = Record<string, unknown>;
interface Context extends Record<string, unknown> {
  fingerprint: string;
  not_modified: false;
  ticket: Ticket;
  omitted: {
    retrieve_with: string;
    arguments: Arguments;
    revision?: number;
    required_before?: 'execution' | 'review';
  }[];
}
interface Retrieval {
  operation: string;
  arguments: Arguments;
  data: unknown;
}
interface ContextPacket {
  context: Context;
  retrieved: Retrieval[];
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const artifactVersion = ({ range: _range, ...metadata }: ArtifactResult) =>
  serializeSuccessEnvelope(metadata);

// One manifest belongs to one SDK client. Reconnecting or changing profiles discards all retained material.
export function createContextManifest(client: Client) {
  let transport = client.transport;
  let instructions = client.getInstructions();
  // shortcut: entries live until forget() or reconnect; add eviction for long-lived clients.
  const retained = new Map<string, string>();
  const connection = () => {
    ensure(client.transport, 'DISCONNECTED', 'Connect the SDK client before reading context.');
    if (transport !== client.transport || instructions !== client.getInstructions()) {
      retained.clear();
      transport = client.transport;
      instructions = client.getInstructions();
    }
    const currentTransport = transport;
    const currentInstructions = instructions;
    return () =>
      ensure(
        currentTransport === client.transport && currentInstructions === client.getInstructions(),
        'CONNECTION_CHANGED',
        'Read again through the current SDK connection.',
      );
  };
  const call = async (operation: string, args: Arguments): Promise<any> => {
    const response = await client.callTool({ name: operation, arguments: args });
    const envelope = response.structuredContent as any;
    ensure(
      envelope && typeof envelope.ok === 'boolean',
      'INVALID_RESPONSE',
      'Expected a ticketing envelope.',
    );
    if (!envelope.ok)
      throw new DomainError(envelope.error.code, envelope.error.message, envelope.error.details);
    return envelope.data;
  };
  return {
    forget() {
      retained.clear();
    },
    async context(input: Arguments, purpose: 'execution' | 'review'): Promise<ContextPacket> {
      const connected = connection();
      const { if_none_match: _ignored, ...args } = schemas.ticket_context.parse(input);
      const key = serializeSuccessEnvelope({ operation: 'ticket_context', args, purpose });
      const saved = retained.get(key);
      const previous: ContextPacket | undefined = saved ? JSON.parse(saved).data : undefined;
      try {
        const context = resultSchemas.ticket_context.parse(
          await call('ticket_context', {
            ...args,
            ...(previous ? { if_none_match: previous.context.fingerprint } : {}),
          }),
        ) as Context | { fingerprint: string; not_modified: true };
        if (context.not_modified) {
          connected();
          ensure(
            previous && context.fingerprint === previous.context.fingerprint,
            'MISSING_CONTEXT',
            'A conditional response requires the exact retained packet.',
          );
          return previous;
        }
        const packet: ContextPacket = { context, retrieved: [] };
        for (const omission of context.omitted) {
          if (omission.required_before !== purpose) continue;
          ensure(
            ['checkpoint_get', 'ticket_history'].includes(omission.retrieve_with),
            'INVALID_RESPONSE',
            'Unsupported required context retrieval.',
          );
          let args: Arguments = omission.arguments;
          for (;;) {
            const operation = omission.retrieve_with as 'checkpoint_get' | 'ticket_history';
            const data = resultSchemas[operation].parse(await call(operation, args));
            if (operation === 'checkpoint_get') {
              const checkpoint = data as Note;
              ensure(
                checkpoint.project_id === context.ticket.project_id &&
                  checkpoint.ticket_id === context.ticket.id &&
                  checkpoint.id === args.checkpoint_id &&
                  (omission.revision === undefined || checkpoint.ticket_revision === omission.revision),
                'INVALID_RESPONSE',
                'Checkpoint identity or revision changed.',
              );
            }
            packet.retrieved.push({ operation, arguments: args, data });
            const page = data as { has_more?: boolean; next_offset?: number };
            if (!page.has_more) break;
            ensure(
              Number.isSafeInteger(page.next_offset) && page.next_offset! > Number(args.offset ?? 0),
              'INVALID_RESPONSE',
              'Required history did not advance.',
            );
            args = { ...args, offset: page.next_offset };
          }
        }
        connected();
        retained.set(key, serializeSuccessEnvelope(packet));
        return packet;
      } catch (error) {
        retained.delete(key);
        throw error;
      }
    },
    async artifact(input: Arguments): Promise<ArtifactResult[]> {
      const connected = connection();
      const args = schemas.artifact_read.parse(input);
      const key = serializeSuccessEnvelope({ operation: 'artifact_read', args });
      const saved = retained.get(key);
      const previous: ArtifactResult[] | undefined = saved ? JSON.parse(saved).data : undefined;
      try {
        if (previous) {
          const current = artifactResultSchema.parse(await call('artifact_read', { ...args, length: 0 }));
          connected();
          if (current.status === 'available' && artifactVersion(current) === artifactVersion(previous[0]!))
            return previous;
          retained.delete(key);
        }
        const pages: ArtifactResult[] = [];
        let offset = args.offset;
        let length = args.length;
        for (;;) {
          const page = artifactResultSchema.parse(await call('artifact_read', { ...args, offset, length }));
          connected();
          ensure(
            /^[a-f0-9]{64}$/.test(page.authorization_binding ?? ''),
            'INVALID_RESPONSE',
            'Artifact pages require a server authorization binding.',
          );
          pages.push(page);
          if (page.status !== 'available') return [page];
          const bytes = Buffer.from(page.range.data, 'base64');
          ensure(
            page.artifact_id === args.artifact_id &&
              /^[a-f0-9]{64}$/.test(page.sha256 ?? '') &&
              page.size_bytes !== null &&
              offset + bytes.length <= Math.max(offset, page.size_bytes) &&
              page.range.offset === offset &&
              page.range.requested_length === length &&
              bytes.toString('base64') === page.range.data &&
              bytes.length === page.range.returned_length &&
              bytes.length <= length &&
              hash(bytes) === page.range.sha256 &&
              artifactVersion(page) === artifactVersion(pages[0]!),
            'INVALID_RESPONSE',
            'Artifact identity, version, or retained bytes changed.',
          );
          if (page.range.unavailable_reason !== 'response_budget') {
            ensure(
              page.range.complete === (bytes.length === length) &&
                (page.range.complete ||
                  ['past_end', 'capture_limit'].includes(page.range.unavailable_reason ?? '')),
              'INVALID_RESPONSE',
              'Artifact range is incomplete.',
            );
            break;
          }
          ensure(
            bytes.length > 0 && bytes.length < length && page.range.next_offset === offset + bytes.length,
            'INVALID_RESPONSE',
            'Artifact pagination did not advance.',
          );
          offset += bytes.length;
          length -= bytes.length;
        }
        const bytes = Buffer.concat(pages.map((page) => Buffer.from(page.range.data, 'base64')));
        if (args.offset === 0 && bytes.length === pages[0]!.size_bytes)
          ensure(hash(bytes) === pages[0]!.sha256, 'INVALID_RESPONSE', 'Artifact capture hash changed.');
        retained.set(key, serializeSuccessEnvelope(pages));
        return pages;
      } catch (error) {
        retained.delete(key);
        throw error;
      }
    },
  };
}
