import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { ensure } from './contracts.js';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const artifactIdentity = new RegExp(`^execution:(${uuid}):(${uuid}):(stdout|stderr|result)$`);
export const MAX_ARTIFACT_RANGE_BYTES = 65_536;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const artifactResultSchema = z.object({
  artifact_id: z.string(),
  status: z.enum(['available', 'missing', 'expired', 'not_configured']),
  size_bytes: count.nullable(),
  total_bytes: count.nullable(),
  omitted_bytes: count.nullable(),
  truncated: z.boolean(),
  sha256: z.string().nullable(),
  expires_at: z.string().nullable(),
  range: z.object({
    offset: count,
    requested_length: count,
    returned_length: count,
    sha256: z.string().nullable(),
    encoding: z.literal('base64'),
    data: z.string(),
    complete: z.boolean(),
    next_offset: count.nullable(),
    unavailable_reason: z
      .enum(['capture_limit', 'past_end', 'response_budget', 'missing', 'expired', 'not_configured'])
      .nullable(),
  }),
  untrusted_content: z.literal(true),
});
export type ArtifactResult = z.infer<typeof artifactResultSchema>;
export interface ArtifactAuthority {
  run_id: string;
  attempt_id: string;
  process_token: string;
  recipe_fingerprint: string;
}

/** Only canonical, authorized execution identities reach this private filesystem boundary. */
export class ExecutionArtifacts {
  private readonly directory: string;
  constructor(
    directory: string,
    private readonly ttlMs = 7 * 24 * 60 * 60_000,
  ) {
    ensure(
      isAbsolute(directory) && Number.isSafeInteger(ttlMs) && ttlMs > 0,
      'INVALID_CONFIG',
      'Configure an absolute artifact directory and positive artifact TTL.',
    );
    // The companion creates this directory; the reader may start before its first execution.
    this.directory = directory;
  }

  private open(run: string, attempt: string, name: string) {
    ensure(
      !lstatSync(this.directory).isSymbolicLink(),
      'INVALID_ARTIFACT',
      'Artifact root links are not allowed.',
    );
    const root = realpathSync(this.directory);
    let path = root;
    for (const component of [run, attempt, name]) {
      path = join(path, component);
      ensure(!lstatSync(path).isSymbolicLink(), 'INVALID_ARTIFACT', 'Artifact links are not allowed.');
    }
    const resolved = realpathSync(path),
      child = relative(root, resolved);
    ensure(
      child !== '' &&
        !isAbsolute(child) &&
        child !== '..' &&
        !child.startsWith(`..${sep}`) &&
        resolved === path,
      'INVALID_ARTIFACT',
      'Artifact escaped its private directory.',
    );
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = fstatSync(fd),
        current = lstatSync(path);
      ensure(
        info.isFile() &&
          info.nlink === 1 &&
          !current.isSymbolicLink() &&
          info.dev === current.dev &&
          info.ino === current.ino &&
          realpathSync(path) === path,
        'INVALID_ARTIFACT',
        'Artifact is not a private regular file.',
      );
      return { fd, size: info.size };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  read(
    artifactId: string,
    authority: ArtifactAuthority,
    offset: number,
    length: number,
    now: number,
  ): ArtifactResult {
    const identity = artifactIdentity.exec(artifactId);
    ensure(
      identity && identity[1] === authority.run_id && identity[2] === authority.attempt_id,
      'INVALID_REFERENCE',
      'Artifact identity does not match this execution attempt.',
    );
    ensure(
      Number.isSafeInteger(offset) &&
        offset >= 0 &&
        Number.isSafeInteger(length) &&
        length >= 0 &&
        length <= MAX_ARTIFACT_RANGE_BYTES &&
        offset <= Number.MAX_SAFE_INTEGER - length,
      'INVALID_INPUT',
      'Provide a bounded byte range.',
    );
    const result = unavailableArtifact(artifactId, offset, length, 'missing');
    try {
      const journal = this.open(identity[1]!, identity[2]!, 'result.json');
      let metadata: any;
      try {
        ensure(
          journal.size <= MAX_ARTIFACT_RANGE_BYTES,
          'INVALID_ARTIFACT',
          'Artifact result journal is too large.',
        );
        const bytes = Buffer.alloc(journal.size);
        ensure(
          readSync(journal.fd, bytes, 0, bytes.length, 0) === bytes.length,
          'INVALID_ARTIFACT',
          'Artifact result journal is incomplete.',
        );
        metadata = JSON.parse(bytes.toString('utf8'));
      } finally {
        closeSync(journal.fd);
      }
      ensure(
        Object.entries(authority).every(([key, value]) => metadata[key] === value) &&
          Number.isSafeInteger(metadata.finished_at) &&
          metadata.finished_at > 0 &&
          metadata.finished_at + this.ttlMs <= 8_640_000_000_000_000,
        'INVALID_ARTIFACT',
        'Artifact result identity is invalid.',
      );
      result.expires_at = new Date(metadata.finished_at + this.ttlMs).toISOString();
      if (now >= metadata.finished_at + this.ttlMs)
        return unavailableArtifact(artifactId, offset, length, 'expired', result.expires_at);
      if (identity[3] === 'result' && metadata.artifact_errors?.includes('OUTCOME_WRITE_FAILED'))
        return result;
      const name = identity[3]!,
        file = this.open(identity[1]!, identity[2]!, name === 'result' ? 'outcome.json' : `${name}.log`);
      try {
        ensure(file.size <= 16 * 1024 * 1024, 'INVALID_ARTIFACT', 'Artifact exceeds the capture limit.');
        // Old journals identify truncation but cannot quantify discarded output.
        const total = metadata.total_bytes?.[name];
        result.status = 'available';
        result.size_bytes = file.size;
        result.truncated = name !== 'result' && metadata.truncated?.[name] === true;
        result.total_bytes =
          Number.isSafeInteger(total) && total >= file.size ? total : result.truncated ? null : file.size;
        result.omitted_bytes = result.total_bytes === null ? null : result.total_bytes - file.size;
        const capturedHash = metadata.sha256?.[name];
        if (typeof capturedHash === 'string' && /^[a-f0-9]{64}$/.test(capturedHash)) {
          ensure(
            name === 'result' || metadata.bytes?.[name] === file.size,
            'INVALID_ARTIFACT',
            'Artifact capture size changed.',
          );
          result.sha256 = capturedHash;
        } else {
          // Legacy immutable logs have no capture hash; hash at most the old 16 MiB capture limit.
          const digest = createHash('sha256'),
            buffer = Buffer.alloc(MAX_ARTIFACT_RANGE_BYTES);
          let position = 0;
          while (position < file.size) {
            const read = readSync(
              file.fd,
              buffer,
              0,
              Math.min(buffer.length, file.size - position),
              position,
            );
            ensure(read > 0, 'INVALID_ARTIFACT', 'Artifact changed during read.');
            digest.update(buffer.subarray(0, read));
            position += read;
          }
          result.sha256 = digest.digest('hex');
        }
        const bytes = Buffer.alloc(Math.min(length, Math.max(0, file.size - offset)));
        ensure(
          readSync(file.fd, bytes, 0, bytes.length, offset) === bytes.length,
          'INVALID_ARTIFACT',
          'Artifact range changed during read.',
        );
        result.range = {
          offset,
          requested_length: length,
          returned_length: bytes.length,
          encoding: 'base64',
          data: bytes.toString('base64'),
          sha256: hash(bytes),
          complete: bytes.length === length,
          next_offset: null,
          unavailable_reason:
            bytes.length === length
              ? null
              : result.truncated && (result.total_bytes === null || offset < result.total_bytes)
                ? 'capture_limit'
                : 'past_end',
        };
        return result;
      } finally {
        closeSync(file.fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
      throw error;
    }
  }
}

export function unavailableArtifact(
  artifactId: string,
  offset: number,
  length: number,
  status: 'missing' | 'expired' | 'not_configured',
  expiresAt: string | null = null,
): ArtifactResult {
  return {
    artifact_id: artifactId,
    status,
    size_bytes: null,
    total_bytes: null,
    omitted_bytes: null,
    truncated: false,
    sha256: null,
    expires_at: expiresAt,
    range: {
      offset,
      requested_length: length,
      returned_length: 0,
      sha256: null,
      encoding: 'base64',
      data: '',
      complete: false,
      next_offset: null,
      unavailable_reason: status,
    },
    untrusted_content: true,
  };
}

/** Budget the encoded envelope, so Unicode, JSON escaping and base64 expansion cannot overrun it. */
export function packArtifactRange(
  result: ArtifactResult,
  maxTokens: number,
  countTokens: (value: unknown) => number,
) {
  const bytes = Buffer.from(result.range.data, 'base64'),
    original = result.range.returned_length;
  const prefix = (length: number): ArtifactResult => ({
    ...result,
    range: {
      ...result.range,
      returned_length: length,
      data: bytes.subarray(0, length).toString('base64'),
      sha256: hash(bytes.subarray(0, length)),
      complete: false,
      next_offset: result.range.offset + length,
      unavailable_reason: 'response_budget',
    },
  });
  // A base64 character needs at most one reference token; bound it before expensive tokenization.
  const metadataTokens = countTokens({ ...result, range: { ...result.range, data: '' } });
  ensure(
    metadataTokens <= maxTokens,
    'RESPONSE_BUDGET_TOO_SMALL',
    'Artifact metadata exceeds the response budget.',
  );
  let length = Math.min(original, Math.max(0, Math.floor((maxTokens - metadataTokens - 16) / 4) * 3));
  let packed = length === original ? result : prefix(length);
  while (countTokens(packed) > maxTokens && length > 0) {
    length = Math.floor(length / 2);
    packed = prefix(length);
  }
  ensure(
    countTokens(packed) <= maxTokens,
    'RESPONSE_BUDGET_TOO_SMALL',
    'Artifact response exceeds the response budget.',
  );
  return packed;
}
