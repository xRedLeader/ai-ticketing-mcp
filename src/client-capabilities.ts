import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ensure, type ClientSelection, type ExecutionHints } from './contracts.js';

const name = z.string().trim().min(1).max(128);
export const clientId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/);
const modelSchema = z.strictObject({ id: name, efforts: z.array(name.max(32)).max(32) });
const recordSchema = z.strictObject({
  id: clientId,
  actor_ids: z.array(z.uuid()).min(1).max(128),
  project_ids: z.array(z.uuid()).min(1).max(128),
  operating_system: name.max(80),
  tools: z.array(name.max(80)).max(128),
  environments: z.array(name.max(80)).min(1).max(32),
  models: z.array(modelSchema).min(1).max(128),
  expires_at: z.iso.datetime(),
});
const registrySchema = z.strictObject({ clients: z.array(recordSchema).max(128) });
export const clientSelectionSchema = z.strictObject({
  client_id: clientId,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  model: name,
  effort: name.max(32).optional(),
  operating_system: name.max(80),
  environment: name.max(80),
  tools: z.array(name.max(80)).max(30),
  requirements_revision: z.number().int().positive(),
});
type ClientRecord = z.output<typeof recordSchema> & { fingerprint: string };
type Request = {
  actor_id: string;
  project_id: string;
  requirements_revision: number;
  tools: readonly string[];
  hints?: ExecutionHints;
  client_id?: string;
};
export type CapabilityMismatch = { code: string; client_id?: string; message: string };
const ordered = (values: string[]) => [...new Set(values)].sort();

/** Operator-owned support declarations select execution; they never grant project roles or tool permissions. */
export class ClientCapabilities {
  private records: ClientRecord[] = [];
  private signature?: string;
  constructor(
    input: unknown,
    private readonly file?: string,
  ) {
    this.replace(input);
  }
  private replace(input: unknown) {
    const config = registrySchema.parse(input);
    ensure(
      new Set(config.clients.map((client) => client.id)).size === config.clients.length,
      'INVALID_CONFIG',
      'Client IDs must be unique.',
    );
    this.records = config.clients
      .map((client) => {
        ensure(
          new Set(client.models.map((model) => model.id)).size === client.models.length,
          'INVALID_CONFIG',
          'Client model IDs must be unique.',
        );
        const normalized = {
          ...client,
          actor_ids: ordered(client.actor_ids),
          project_ids: ordered(client.project_ids),
          tools: ordered(client.tools),
          environments: ordered(client.environments),
          models: client.models
            .map((model) => ({ ...model, efforts: ordered(model.efforts) }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        };
        return {
          ...normalized,
          fingerprint: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
        };
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  private current() {
    if (this.file) {
      const info = statSync(this.file),
        signature = `${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
      if (signature !== this.signature) {
        const fd = openSync(this.file, 'r');
        try {
          ensure(
            fstatSync(fd).size <= 1_048_576,
            'INVALID_CONFIG',
            'Client capability registry exceeds 1 MiB.',
          );
          this.replace(JSON.parse(readFileSync(fd, 'utf8')));
          this.signature = signature;
        } finally {
          closeSync(fd);
        }
      }
    }
    return this.records;
  }
  tools(actor: string, project: string, now: number) {
    return ordered(
      this.current()
        .filter(
          (client) =>
            client.actor_ids.includes(actor) &&
            client.project_ids.includes(project) &&
            Date.parse(client.expires_at) > now,
        )
        .flatMap((client) => client.tools),
    );
  }
  match(request: Request, now: number): { selection: ClientSelection | null; reasons: CapabilityMismatch[] } {
    const hints = request.hints ?? {},
      pinned = hints.client_id;
    if (pinned && request.client_id && pinned !== request.client_id)
      return {
        selection: null,
        reasons: [
          {
            code: 'PINNED_CLIENT_CONFLICT',
            message: `Use pinned client ${pinned}; the request selected another client.`,
          },
        ],
      };
    const clientId = pinned ?? request.client_id;
    const clients = this.current().filter(
      (client) =>
        client.actor_ids.includes(request.actor_id) &&
        client.project_ids.includes(request.project_id) &&
        (!clientId || client.id === clientId),
    );
    const reasons: CapabilityMismatch[] = [];
    for (const client of clients) {
      const reject = (code: string, message: string) => {
        if (reasons.length < 3) reasons.push({ code, client_id: client.id, message });
      };
      if (Date.parse(client.expires_at) <= now) {
        reject('CLIENT_STALE', 'Ask the operator to refresh this expired client registration.');
        continue;
      }
      if (hints.operating_system && hints.operating_system !== client.operating_system) {
        reject(
          'UNSUPPORTED_OS',
          `Requires ${hints.operating_system}; client runs ${client.operating_system}.`,
        );
        continue;
      }
      if (hints.environment && !client.environments.includes(hints.environment)) {
        reject('UNSUPPORTED_ENVIRONMENT', `Requires execution environment ${hints.environment}.`);
        continue;
      }
      const missing = request.tools.filter((tool) => !client.tools.includes(tool));
      if (missing.length) {
        reject(
          'MISSING_TOOLS',
          `Requires registered tools: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}.`,
        );
        continue;
      }
      const models = client.models.filter((model) => !hints.model || model.id === hints.model);
      if (!models.length) {
        reject(
          'UNSUPPORTED_MODEL',
          `Requires model ${hints.model}; choose a supported model or ask the operator to register it.`,
        );
        continue;
      }
      const model = models.find((model) => !hints.effort || model.efforts.includes(hints.effort));
      if (!model) {
        reject(
          'UNSUPPORTED_EFFORT',
          `Requires effort ${hints.effort} for the requested model; pinned choices are never downgraded.`,
        );
        continue;
      }
      return {
        selection: {
          client_id: client.id,
          fingerprint: client.fingerprint,
          model: model.id,
          ...(hints.effort ? { effort: hints.effort } : {}),
          operating_system: client.operating_system,
          environment: hints.environment ?? client.environments[0]!,
          tools: ordered([...request.tools]),
          requirements_revision: request.requirements_revision,
        },
        reasons: [],
      };
    }
    if (!clients.length)
      reasons.push({
        code: 'CLIENT_NOT_AUTHORIZED',
        message: 'Ask the operator to register an authorized client for your identity and this project.',
      });
    return { selection: null, reasons };
  }
  verify(
    selection: ClientSelection,
    actor: string,
    project: string,
    model: string,
    revision: number,
    now: number,
  ) {
    const parsed = clientSelectionSchema.parse(selection);
    const matched = this.match(
      {
        actor_id: actor,
        project_id: project,
        requirements_revision: revision,
        tools: parsed.tools,
        hints: {
          client_id: parsed.client_id,
          model: parsed.model,
          ...(parsed.effort ? { effort: parsed.effort } : {}),
          operating_system: parsed.operating_system,
          environment: parsed.environment,
        },
      },
      now,
    );
    if (!matched.selection) return matched.reasons;
    if (
      model !== parsed.model ||
      revision !== parsed.requirements_revision ||
      matched.selection.fingerprint !== parsed.fingerprint
    )
      return [
        {
          code: 'STALE_CLIENT_SELECTION',
          message:
            'Reclaim work and match again; the pinned client registration, model or requirements changed.',
        },
      ];
    return [];
  }
}

export function loadClientCapabilities(path: string) {
  ensure(
    isAbsolute(path),
    'INVALID_CONFIG',
    'CLIENT_CAPABILITIES_FILE must be an absolute operator-owned path.',
  );
  // Load and validate lazily on the first authorized request; subsequent file changes revoke old pins.
  return new ClientCapabilities({ clients: [] }, path);
}
