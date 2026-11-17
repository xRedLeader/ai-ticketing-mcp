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
