import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { buffer } from 'node:stream/consumers';
import { DomainError } from './contracts.js';

const maxBytes = 8192;

export async function readWorkerAdvice(filename: string): Promise<string> {
  try {
    const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (stat.isFile() && stat.size <= maxBytes) {
        const bytes = await buffer(file.createReadStream({ start: 0, end: maxBytes }));
        if (bytes.length <= maxBytes) {
          const guide = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          if (typeof guide?.advice === 'string' && guide.advice.trim() && !guide.advice.includes('\0'))
            return guide.advice.trim();
        }
      }
    } finally {
      await file.close();
    }
  } catch {
    // Give clients the same recovery without exposing a local path or file content.
  }
  throw new DomainError(
    'WORKER_GUIDE_UNAVAILABLE',
    'Ask the operator to restore a valid worker guide, then read ticketing://guide or call project_list.',
  );
}
