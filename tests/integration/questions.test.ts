import { it } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

it('retrieves only unanswered nonblocking questions with deterministic lossless omission references', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket();
    const questions: string[] = [];
    for (let index = 0; index < 4; index++) {
      f.clock.now = new Date(f.clock.now.getTime() + 1000);
      const question = (await f.call(f.worker.id, 'ticket_note', {
        ticket_id: ticket.id,
        kind: 'question',
        body: `Question ${index}?`,
      })) as any;
      questions.push(question.note.id);
      await f.call(f.worker.id, 'ticket_note', { ticket_id: ticket.id, body: `Unrelated comment ${index}.` });
    }
    await f.call(f.worker.id, 'ticket_note', {
      ticket_id: ticket.id,
      kind: 'answer',
      answer_to: questions[1],
      body: 'Already answered.',
    });
    await f.call(f.worker.id, 'ticket_note', {
      ticket_id: ticket.id,
      kind: 'answer',
      answer_to: questions[1],
      body: 'Another answer.',
    });
    await f.call(f.worker.id, 'ticket_note', {
      ticket_id: ticket.id,
      kind: 'question',
      body: 'Blocking question?',
      blocking: true,
    });
    const input = {
      project_id: f.project.id,
      ticket_id: ticket.id,
      kind: 'notes',
      unanswered_questions: true,
    };
    const first = (await f.app.execute(f.worker.id, 'ticket_history', { ...input, limit: 1 })) as any;
    const second = (await f.app.execute(f.worker.id, 'ticket_history', {
      ...input,
      limit: 1,
      offset: 1,
    })) as any;
    assert.equal(first.items[0].id, questions[0]);
    assert.equal(second.items[0].id, questions[2]);
    const context = (await f.app.execute(f.worker.id, 'ticket_context', {
      project_id: f.project.id,
      ticket_id: ticket.id,
    })) as any;
    assert.equal(context.open_questions[0].id, questions[0]);
    const reference = context.omitted.find((entry: any) => entry.section === 'open_questions_more');
    assert.equal(reference.retrieve_with, 'ticket_history');
    assert.equal(reference.arguments.unanswered_questions, true);
    assert.equal(reference.arguments.offset, 0);
    await f.call(f.worker.id, 'ticket_note', {
      ticket_id: ticket.id,
      kind: 'answer',
      answer_to: questions[0],
      body: 'Answered after the context snapshot.',
    });
    const remaining = (await f.app.execute(f.worker.id, reference.retrieve_with, reference.arguments)) as any;
    assert.deepEqual(
      remaining.items.map((entry: any) => entry.id),
      questions.slice(2),
    );
    const allNotes = (await f.app.execute(f.worker.id, 'ticket_history', {
      project_id: f.project.id,
      ticket_id: ticket.id,
      kind: 'notes',
      limit: 100,
    })) as any;
    assert.ok(allNotes.items.some((entry: any) => entry.kind === 'comment'));
    const exact = (await f.app.execute(f.worker.id, 'ticket_history', {
      project_id: f.project.id,
      ticket_id: ticket.id,
      item_id: questions[1],
    })) as any;
    assert.deepEqual(
      exact.items.map((entry: any) => entry.id),
      [questions[1]],
    );
  } finally {
    await f.dispose();
  }
});

it('returns an exact filtered fallback when the whole optional question section is omitted', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket();
    const long = (await f.call(f.worker.id, 'ticket_note', {
      ticket_id: ticket.id,
      kind: 'question',
      body: 'x '.repeat(7500),
    })) as any;
    f.clock.now = new Date(f.clock.now.getTime() + 1000);
    const next = (await f.call(f.worker.id, 'ticket_note', {
      ticket_id: ticket.id,
      kind: 'question',
      body: 'Next question?',
    })) as any;
    await f.call(f.worker.id, 'ticket_note', { ticket_id: ticket.id, body: 'Newer unrelated comment.' });
    const context = (await f.app.execute(f.worker.id, 'ticket_context', {
      project_id: f.project.id,
      ticket_id: ticket.id,
    })) as any;
    assert.equal(context.open_questions, undefined);
    const omitted = context.omitted.find((entry: any) => entry.section === 'open_questions');
    const retrieved = (await f.app.execute(f.worker.id, omitted.retrieve_with, omitted.arguments)) as any;
    assert.deepEqual(
      retrieved.items.map((entry: any) => entry.id),
      [long.note.id, next.note.id],
    );
  } finally {
    await f.dispose();
  }
});
