import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import { ensure } from './contracts.js';

export const EXECUTION_TIMEOUT_MS = 30 * 60_000;
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const recipeSchema = z.strictObject({
  id: identifier,
  project_ids: z.array(z.uuid()).min(1).max(128),
  executable: z.string().min(1).max(4096),
  argv: z
    .array(
      z
        .string()
        .max(8192)
        .refine((value) => !value.includes('\0')),
    )
    .max(128),
  cwd: z.string().min(1).max(4096),
  env: z.record(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/), z.string().max(32768)),
  timeout_ms: z.number().int().positive().max(EXECUTION_TIMEOUT_MS).default(EXECUTION_TIMEOUT_MS),
  max_log_bytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024)
    .default(1024 * 1024),
  resources: z
    .strictObject({ cpu_millis: count.default(0), memory_bytes: count.default(0) })
    .default(() => ({ cpu_millis: 0, memory_bytes: 0 })),
});
const registrySchema = z.strictObject({
  workspace_roots: z.array(z.string().min(1).max(4096)).min(1).max(32),
  recipes: z.array(recipeSchema).max(128),
});
export type ExecutionRecipe = Readonly<
  Omit<z.output<typeof recipeSchema>, 'argv' | 'env' | 'project_ids' | 'resources'> & {
    argv: readonly string[];
    env: Readonly<Record<string, string>>;
    project_ids: readonly string[];
    resources: Readonly<{ cpu_millis: number; memory_bytes: number }>;
    fingerprint: string;
  }
>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Operator-owned, immutable configuration; no executable, argument or environment input comes from MCP. */
export class ExecutionRecipeRegistry {
  private readonly recipes: readonly ExecutionRecipe[];

  constructor(input: unknown) {
    const config = registrySchema.parse(input);
    const roots = config.workspace_roots.map((root) => {
      ensure(isAbsolute(root), 'INVALID_CONFIG', 'Execution workspace roots must be absolute.');
      const path = realpathSync(root);
      ensure(statSync(path).isDirectory(), 'INVALID_CONFIG', 'Execution workspace root must be a directory.');
      return path;
    });
    ensure(
      new Set(config.recipes.map((recipe) => recipe.id)).size === config.recipes.length,
      'INVALID_CONFIG',
      'Execution recipe IDs must be unique.',
    );
    this.recipes = Object.freeze(
      config.recipes.map((recipe) => {
        ensure(
          isAbsolute(recipe.cwd) && isAbsolute(recipe.executable),
          'INVALID_CONFIG',
          'Execution cwd and executable must be absolute.',
        );
        const cwd = realpathSync(recipe.cwd),
          executable = realpathSync(recipe.executable);
        ensure(
          statSync(cwd).isDirectory() &&
            roots.some((root) => {
              const child = relative(root, cwd);
              return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
            }),
          'INVALID_CONFIG',
          'Execution cwd must be inside an allowed workspace.',
        );
        const executableStat = statSync(executable);
        ensure(executableStat.isFile(), 'INVALID_CONFIG', 'Execution executable must be a file.');
        const fd = openSync(executable, 'r'),
          header = Buffer.alloc(64);
        let native = false;
        try {
          const length = readSync(fd, header, 0, header.length, 0);
          if (process.platform === 'win32' && length === 64 && header.toString('ascii', 0, 2) === 'MZ') {
            const pe = Buffer.alloc(4),
              offset = header.readUInt32LE(60);
            native =
              offset <= executableStat.size - 4 &&
              readSync(fd, pe, 0, 4, offset) === 4 &&
              pe.equals(Buffer.from('PE\0\0'));
          } else if (process.platform !== 'win32')
            native =
              [
                '7f454c46',
                'feedface',
                'cefaedfe',
                'feedfacf',
                'cffaedfe',
                'cafebabe',
                'bebafeca',
                'cafebabf',
                'bfbafeca',
              ].includes(header.subarray(0, 4).toString('hex')) && (executableStat.mode & 0o111) !== 0;
        } finally {
          closeSync(fd);
        }
        ensure(
          native && (process.platform !== 'win32' || extname(executable).toLowerCase() === '.exe'),
          'INVALID_CONFIG',
          'Execution requires a native executable, not a shell script.',
        );
        const envKeys = Object.keys(recipe.env);
        ensure(
          envKeys.length <= 128 && envKeys.every((key) => !recipe.env[key]!.includes('\0')),
          'INVALID_CONFIG',
          'Execution environment is too large or contains NUL.',
        );
        ensure(
          process.platform !== 'win32' ||
            new Set(envKeys.map((key) => key.toUpperCase())).size === envKeys.length,
          'INVALID_CONFIG',
          'Execution environment keys must be unique ignoring case on Windows.',
        );
        const normalized = {
          ...recipe,
          executable,
          cwd,
          project_ids: [...new Set(recipe.project_ids)].sort(),
        };
        return Object.freeze({
          ...normalized,
          argv: Object.freeze([...recipe.argv]),
          env: Object.freeze({ ...recipe.env }),
          project_ids: Object.freeze(normalized.project_ids),
          resources: Object.freeze({ ...recipe.resources }),
          fingerprint: createHash('sha256').update(canonical(normalized)).digest('hex'),
        });
      }),
    );
  }

  metadata() {
    return this.recipes.map(({ id, fingerprint, project_ids }) => ({ id, fingerprint, project_ids }));
  }

  get(id: string, fingerprint: string, projectId: string): ExecutionRecipe {
    const recipe = this.recipes.find((item) => item.id === id);
    ensure(
      recipe && recipe.fingerprint === fingerprint && recipe.project_ids.includes(projectId),
      'INVALID_CONFIG',
      'Execution recipe is missing, changed or not allowed for this project.',
    );
    return recipe;
  }
}

export function loadExecutionRecipes(path: string): ExecutionRecipeRegistry {
  ensure(isAbsolute(path), 'INVALID_CONFIG', 'EXECUTION_RECIPES_FILE must be an absolute path.');
  ensure(statSync(path).size <= 1024 * 1024, 'INVALID_CONFIG', 'Execution registry exceeds 1 MiB.');
  return new ExecutionRecipeRegistry(JSON.parse(readFileSync(path, 'utf8')));
}
