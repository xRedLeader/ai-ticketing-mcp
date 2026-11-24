import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { ensure, type ArtifactRetirement } from './contracts.js';
import { durableExecutionFile } from './execution-journal.js';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const artifactIdentity = new RegExp(`^execution:(${uuid}):(${uuid}):(stdout|stderr|result)$`);
export const MAX_ARTIFACT_RANGE_BYTES = 65_536;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const artifactResultSchema = z.object({
  artifact_id: z.string(),
  authorization_binding: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
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
type RetentionProof = Pick<
  ArtifactRetirement,
  'expires_at' | 'size_bytes' | 'sha256' | 'root_identity' | 'file_identity'
>;

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
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
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
      return { fd, size: info.size, path };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  private retentionJournal(artifactId: string, authority: ArtifactAuthority, settledAt: number, now: number) {
    const identity = artifactIdentity.exec(artifactId);
    ensure(
      identity &&
        identity[3] !== 'result' &&
        identity[1] === authority.run_id &&
        identity[2] === authority.attempt_id,
      'INVALID_REFERENCE',
      'Only an exact published stdout/stderr log can be retired.',
    );
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
        metadata.cleanup_verified === true &&
        Number.isSafeInteger(metadata.finished_at) &&
        metadata.finished_at > 0 &&
        Number.isFinite(settledAt) &&
        metadata.finished_at <= settledAt &&
        settledAt + this.ttlMs <= now,
      'ARTIFACT_NOT_EXPIRED',
      'Retirement requires a verified terminal journal and expired durable settlement.',
    );
    ensure(
      !lstatSync(this.directory).isSymbolicLink(),
      'INVALID_ARTIFACT',
      'Artifact root links are not allowed.',
    );
    const root = realpathSync(this.directory),
      info = lstatSync(root, { bigint: true });
    ensure(info.isDirectory() && info.ino > 0n, 'INVALID_ARTIFACT', 'Artifact root identity is unavailable.');
    return {
      identity,
      metadata,
      root_identity: hash(
        Buffer.from(JSON.stringify([root, String(info.dev), String(info.ino), String(info.birthtimeNs)])),
      ),
      expires_at: new Date(settledAt + this.ttlMs).toISOString(),
    };
  }
  inspectRetirement(
    artifactId: string,
    authority: ArtifactAuthority,
    settledAt: number,
    now: number,
  ): RetentionProof {
    const journal = this.retentionJournal(artifactId, authority, settledAt, now);
    const name = journal.identity[3]!;
    const file = this.open(authority.run_id, authority.attempt_id, `${name}.log`);
    try {
      ensure(
        file.size <= 16 * 1024 * 1024 && journal.metadata.bytes?.[name] === file.size,
        'INVALID_ARTIFACT',
        'Retirement requires an unchanged bounded capture.',
      );
      const digest = createHash('sha256'),
        bytes = Buffer.alloc(MAX_ARTIFACT_RANGE_BYTES);
      for (let position = 0; position < file.size;) {
        const read = readSync(file.fd, bytes, 0, Math.min(bytes.length, file.size - position), position);
        ensure(read > 0, 'INVALID_ARTIFACT', 'Artifact changed during inspection.');
        digest.update(bytes.subarray(0, read));
        position += read;
      }
      const sha256 = digest.digest('hex');
      ensure(
        sha256 === journal.metadata.sha256?.[name],
        'INVALID_ARTIFACT',
        'Retirement requires the trusted capture hash.',
      );
      const info = fstatSync(file.fd, { bigint: true });
      ensure(info.ino > 0n, 'INVALID_ARTIFACT', 'Artifact file identity is unavailable.');
      return {
        expires_at: journal.expires_at,
        root_identity: journal.root_identity,
        size_bytes: file.size,
        sha256,
        file_identity: JSON.stringify([
          String(info.dev),
          String(info.ino),
          String(info.size),
          String(info.mtimeNs),
          String(info.birthtimeNs),
        ]),
      };
    } finally {
      closeSync(file.fd);
    }
  }
  unlinkRetired(decision: ArtifactRetirement, authority: ArtifactAuthority, settledAt: number, now: number) {
    ensure(
      process.platform === 'linux',
      'UNSUPPORTED_PHYSICAL_CLEANUP',
      'Physical cleanup requires Linux directory handles.',
    );
    const journal = this.retentionJournal(decision.id, authority, settledAt, now);
    ensure(
      journal.root_identity === decision.root_identity && journal.expires_at === decision.expires_at,
      'INVALID_ARTIFACT',
      'Retirement ownership changed.',
    );
    const handles: number[] = [];
    const directory = (path: string) => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(fd);
      const info = fstatSync(fd, { bigint: true });
      ensure(
        info.isDirectory() && info.uid === BigInt(process.getuid!()) && (info.mode & 0o022n) === 0n,
        'INVALID_ARTIFACT',
        'Retirement directories must be owned and protected from other writers.',
      );
      return fd;
    };
    const openCapture = (path: string) => {
      try {
        return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    };
    const matches = (fd: number) => {
      const info = fstatSync(fd, { bigint: true });
      if (
        !info.isFile() ||
        info.nlink !== 1n ||
        info.uid !== BigInt(process.getuid!()) ||
        JSON.stringify([
          String(info.dev),
          String(info.ino),
          String(info.size),
          String(info.mtimeNs),
          String(info.birthtimeNs),
        ]) !== decision.file_identity
      )
        return false;
      const digest = createHash('sha256'),
        bytes = Buffer.alloc(MAX_ARTIFACT_RANGE_BYTES);
      for (let position = 0; position < decision.size_bytes;) {
        const read = readSync(fd, bytes, 0, Math.min(bytes.length, decision.size_bytes - position), position);
        if (read <= 0) return false;
        digest.update(bytes.subarray(0, read));
        position += read;
      }
      return digest.digest('hex') === decision.sha256;
    };
    try {
      const root = realpathSync(this.directory),
        rootFd = directory(root),
        rootInfo = fstatSync(rootFd, { bigint: true });
      ensure(
        hash(
          Buffer.from(
            JSON.stringify([root, String(rootInfo.dev), String(rootInfo.ino), String(rootInfo.birthtimeNs)]),
          ),
        ) === decision.root_identity,
        'INVALID_ARTIFACT',
        'Retirement root changed before staging.',
      );
      const runFd = directory(`/proc/self/fd/${rootFd}/${authority.run_id}`);
      const attemptFd = directory(`/proc/self/fd/${runFd}/${authority.attempt_id}`);
      const parent = `/proc/self/fd/${attemptFd}`,
        name = `${journal.identity[3]}.log`;
      const stageName = `.retired-${journal.identity[3]}`,
        stage = `${parent}/${stageName}`;
      let created = false;
      try {
        mkdirSync(stage, { mode: 0o700 });
        created = true;
        fsyncSync(attemptFd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const stageFd = directory(stage),
        anchoredStage = `/proc/self/fd/${stageFd}`;
      const marker = {
        id: decision.id,
        root_identity: decision.root_identity,
        file_identity: decision.file_identity,
        sha256: decision.sha256,
      };
      if (created) {
        durableExecutionFile(`${anchoredStage}/decision.json`, marker);
        fsyncSync(stageFd);
      }
      const markerFd = openCapture(`${anchoredStage}/decision.json`);
      ensure(
        markerFd !== null,
        'ARTIFACT_STAGING_CONFLICT',
        'Retirement staging marker is missing; no capture was removed. Inspect the protected staging directory before retrying.',
        { staging_directory: stageName },
      );
      try {
        const info = fstatSync(markerFd);
        ensure(
          info.isFile() &&
            info.nlink === 1 &&
            info.size <= 4096 &&
            JSON.stringify(JSON.parse(readFileSync(markerFd, 'utf8'))) === JSON.stringify(marker),
          'ARTIFACT_STAGING_CONFLICT',
          'Retirement staging ownership is uncertain; inspect the protected staging directory.',
        );
      } finally {
        closeSync(markerFd);
      }
      const capture = `${anchoredStage}/capture`,
        source = `${parent}/${name}`;
      let fd = openCapture(capture);
      if (fd === null) {
        fd = openCapture(source);
        if (fd === null) return false;
        try {
          ensure(matches(fd), 'INVALID_ARTIFACT', 'Retirement file identity changed.');
        } finally {
          closeSync(fd);
        }
        renameSync(source, capture);
        fsyncSync(attemptFd);
        fsyncSync(stageFd);
        fd = openCapture(capture);
        ensure(
          fd !== null,
          'ARTIFACT_STAGING_CONFLICT',
          'Staged capture disappeared; inspect the protected staging directory.',
        );
      }
      try {
        if (!matches(fd)) {
          try {
            linkSync(capture, source);
            fsyncSync(attemptFd);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          ensure(
            false,
            'ARTIFACT_STAGING_CONFLICT',
            'Selected file changed during staging. Bytes remain in the protected staging directory; inspect it before retrying.',
            { staging_directory: stageName },
          );
        }
        // This owner-only staging directory is never a recipe output directory.
        unlinkSync(capture);
        fsyncSync(stageFd);
      } finally {
        closeSync(fd);
      }
      return true;
    } finally {
      for (const fd of handles.reverse()) closeSync(fd);
    }
  }
  read(
    artifactId: string,
    authority: ArtifactAuthority,
    offset: number,
    length: number,
    now: number,
    pinned = false,
    requireCapturedHash = false,
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
      if (now >= metadata.finished_at + this.ttlMs) {
        if (!pinned) return unavailableArtifact(artifactId, offset, length, 'expired', result.expires_at);
        result.expires_at = null;
      }
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
        ensure(
          !requireCapturedHash || (typeof capturedHash === 'string' && /^[a-f0-9]{64}$/.test(capturedHash)),
          'INVALID_ARTIFACT',
          'Verified reuse requires an original captured hash.',
        );
        ensure(
          capturedHash === undefined || name === 'result' || metadata.bytes?.[name] === file.size,
          'INVALID_ARTIFACT',
          'Artifact capture size changed.',
        );
        const bytes = Buffer.alloc(Math.min(length, Math.max(0, file.size - offset)));
        const rangeEnd = offset + bytes.length;
        const digest = createHash('sha256');
        const buffer = Buffer.alloc(Math.min(MAX_ARTIFACT_RANGE_BYTES, file.size));
        // Copy the returned range from the same chunks used to verify the capture.
        let position = 0;
        while (position < file.size) {
          const read = readSync(file.fd, buffer, 0, Math.min(buffer.length, file.size - position), position);
          ensure(read > 0, 'INVALID_ARTIFACT', 'Artifact changed during read.');
          const end = position + read;
          const from = Math.max(position, offset);
          const to = Math.min(end, rangeEnd);
          digest.update(buffer.subarray(0, read));
          if (from < to) buffer.copy(bytes, from - offset, from - position, to - position);
          position = end;
        }
        result.sha256 = digest.digest('hex');
        ensure(
          fstatSync(file.fd).size === file.size &&
            (capturedHash === undefined || capturedHash === result.sha256),
          'INVALID_ARTIFACT',
          'Artifact does not match its capture.',
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
