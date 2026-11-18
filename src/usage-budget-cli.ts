#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { UsageBudget } from './usage-budget.js';
import { DomainError, ensure } from './contracts.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    ledger: { type: 'string' },
    run: { type: 'string' },
    attempt: { type: 'string' },
    'input-file': { type: 'string' },
  },
});
let ledger: UsageBudget | undefined;
try {
  const command = positionals[0];
  ensure(
    ['create', 'admit', 'settle', 'accept', 'report'].includes(command ?? '') && values.ledger,
    'INVALID_INPUT',
    'Usage: node dist/usage-budget-cli.js create|admit|settle|accept|report --ledger PATH [--run ID] [--attempt ID] [--input-file JSON]',
  );
  ensure(command === 'create' || values.run, 'INVALID_INPUT', '--run is required.');
  ensure(command !== 'settle' || values.attempt, 'INVALID_INPUT', '--attempt is required.');
  ensure(command === 'report' || values['input-file'], 'INVALID_INPUT', '--input-file is required.');
  const input: unknown = values['input-file']
    ? JSON.parse(await readFile(values['input-file'], 'utf8'))
    : null;
  ledger = new UsageBudget(values.ledger);
  // Each method validates the JSON at the local operator boundary.
  const result =
    command === 'create'
      ? ledger.createRun(input as Parameters<UsageBudget['createRun']>[0])
      : command === 'admit'
        ? ledger.admit(values.run!, input as Parameters<UsageBudget['admit']>[1])
        : command === 'settle'
          ? ledger.settle(values.run!, values.attempt!, input as Parameters<UsageBudget['settle']>[2])
          : command === 'accept'
            ? ledger.recordAcceptance(values.run!, input as Parameters<UsageBudget['recordAcceptance']>[1])
            : ledger.report(values.run!);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if ('status' in result && result.status === 'needs_attention') process.exitCode = 2;
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      error: error instanceof DomainError ? error.code : 'USAGE_BUDGET_ERROR',
      message: error instanceof Error ? error.message : 'Usage budget command failed.',
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  ledger?.close();
}
