import { getEncoding } from 'js-tiktoken';

const encoding = getEncoding('o200k_base');
export const countReferenceTokens = (text: string) => encoding.encode(text, [], []).length;

export function queryExcerpt(text: string, query: string, count = countReferenceTokens): string {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const matches = terms.map((term) => new RegExp(term, 'iu').exec(text)?.index ?? -1).filter((at) => at >= 0);
  const at = matches.length ? Math.min(...matches) : 0;
  const before = Array.from(text.slice(Math.max(0, at - 200), at).replace(/^[\uDC00-\uDFFF]/u, '')).slice(
    -100,
  );
  const after = Array.from(text.slice(at, at + 1600).replace(/[\uD800-\uDBFF]$/u, ''));
  let low = 0;
  let high = before.length;
  let prefix = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = before.slice(before.length - middle).join('');
    if (count(candidate) <= 60) {
      prefix = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  low = 0;
  high = after.length;
  let excerpt = prefix;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = prefix + after.slice(0, middle).join('');
    if (count(candidate) <= 200) {
      excerpt = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return count(excerpt) <= 200 ? excerpt : '';
}
