import { getEncoding } from 'js-tiktoken';

const encoding = getEncoding('o200k_base');
export const countReferenceTokens = (text: string) => encoding.encode(text, [], []).length;

export function queryExcerpt(text: string, query: string, count = countReferenceTokens): string {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const matches = terms.map((term) => new RegExp(term, 'iu').exec(text)?.index ?? -1).filter((at) => at >= 0);
  const at = matches.length ? Math.min(...matches) : 0;
  const characters = Array.from(text);
  const center = Array.from(text.slice(0, at)).length;
  let start = Math.max(0, center - 100);
  while (count(characters.slice(start, center).join('')) > 60) start++;
  let low = center;
  let high = Math.min(characters.length, center + 800);
  let end = center;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (count(characters.slice(start, middle).join('')) <= 200) {
      end = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return characters.slice(start, end).join('');
}
