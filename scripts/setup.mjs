import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
let template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
template = template.replaceAll('replace-with-generated-hex', () => randomBytes(32).toString('hex'));
try {
  await writeFile(new URL('../.env', import.meta.url), template, { flag: 'wx', mode: 0o600 });
  process.stdout.write(
    'Created private .env. Start with docker compose --profile auth --profile local-ai up -d --build\n',
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const existing = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
  const placeholders = [
    'DB_PASSWORD',
    'APP_DB_PASSWORD',
    'KEYCLOAK_DB_PASSWORD',
    'KEYCLOAK_ADMIN_PASSWORD',
  ].filter((name) => existing[name] === 'replace-with-generated-hex');
  if (placeholders.length) {
    process.stderr.write(`Replace example passwords in .env: ${placeholders.join(', ')}.\n`);
    process.exitCode = 1;
  } else process.stdout.write('.env already exists; preserved existing settings.\n');
}
