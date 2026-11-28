import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createManagedProfileRecorder, type ProfileRecorder } from '../src/profiling.js';

const reservation = 1024 + 2 * 256 * 1024;
async function captureDirectory(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-profile-admission-'));
  try {
    await work(directory);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('ticketing-profile-admission-'));
    await rm(directory, { recursive: true, force: true });
  }
}
const start = (directory: string, quota: number) =>
  createManagedProfileRecorder({ directory, maxFileBytes: 1024, maxFiles: 1 }, quota);

it('admits simultaneous recorders when their reservations fit the quota', async () => {
  await captureDirectory(async (directory) => {
    const recorders = await Promise.all(Array.from({ length: 8 }, () => start(directory, reservation * 8)));
    try {
      assert.equal(new Set(recorders.map((recorder) => recorder.runDirectory)).size, 8);
      assert.equal((await readdir(directory)).includes('.capture-admission'), false);
    } finally {
      await Promise.all(recorders.map((recorder) => recorder.close()));
    }
  });
});

it('serializes simultaneous quota checks without overbooking or confusing contention with quota', async () => {
  await captureDirectory(async (directory) => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => start(directory, reservation)));
    const admitted = results.filter(
      (result): result is PromiseFulfilledResult<ProfileRecorder> => result.status === 'fulfilled',
    );
    try {
      assert.equal(admitted.length, 1);
      for (const result of results)
        if (result.status === 'rejected') assert.equal(result.reason.message, 'CAPTURE_QUOTA');
      assert.equal((await readdir(directory)).includes('.capture-admission'), false);
    } finally {
      await Promise.all(admitted.map((result) => result.value.close()));
    }
  });
});

it('bounds waiting on a stale admission lock and leaves it for operator inspection', async () => {
  await captureDirectory(async (directory) => {
    await mkdir(join(directory, '.capture-admission'));
    await assert.rejects(start(directory, reservation), { message: 'CAPTURE_ADMISSION_BUSY' });
    assert.deepEqual(await readdir(directory), ['.capture-admission']);
  });
});
