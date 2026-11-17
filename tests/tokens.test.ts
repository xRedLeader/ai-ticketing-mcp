import { it } from 'node:test';
import assert from 'node:assert/strict';
import { countReferenceTokens, queryExcerpt } from '../src/tokens.js';

it('counts ordinary special-token strings and centers bounded Unicode excerpts on the query', () => {
  assert.ok(countReferenceTokens('literal <|endoftext|> <|fim_prefix|> 🧪') > 0);
  const text = 'İ'.repeat(1500) + ' target-boundary ' + '🧪'.repeat(500);
  const excerpt = queryExcerpt(text, 'target');
  assert.ok(excerpt.includes('target-boundary'));
  assert.ok(countReferenceTokens(excerpt) <= 200);
  assert.ok(excerpt.isWellFormed());
  assert.equal(queryExcerpt('', 'nothing'), '');
});

it('bounds encoder calls and input windows for an adversarial Unicode prefix', () => {
  const text = '🧬'.repeat(50_000) + 'x target-boundary ' + '🧪'.repeat(2000);
  let calls = 0;
  const excerpt = queryExcerpt(text, 'target', (value) => {
    calls++;
    assert.ok(value.length <= 1800, 'Only a bounded window reaches the encoder.');
    return countReferenceTokens(value);
  });
  assert.ok(calls <= 20, `Expected logarithmic selection; observed ${calls} encoder calls.`);
  assert.ok(excerpt.includes('target-boundary'));
  assert.ok(excerpt.isWellFormed());
  assert.ok(countReferenceTokens(excerpt) <= 200);
});

it('keeps original Unicode match offsets and repairs bounded-window surrogate edges', () => {
  const text = 'İ'.repeat(1000) + '🧬'.repeat(200) + 'x TARGET-boundary ' + '🧪'.repeat(2000);
  const excerpt = queryExcerpt(text, 'target');
  assert.ok(excerpt.includes('TARGET-boundary'));
  assert.ok(excerpt.isWellFormed());
  assert.ok(countReferenceTokens(excerpt) <= 200);
  const literal = queryExcerpt(
    'prefix '.repeat(500) + 'target <|endoftext|> ' + 'suffix '.repeat(500),
    'target',
  );
  assert.ok(literal.includes('target <|endoftext|>'));
  assert.ok(countReferenceTokens(literal) <= 200);
});
