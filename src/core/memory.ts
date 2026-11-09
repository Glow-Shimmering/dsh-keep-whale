/** Local, deterministic helpers for Chinese/English lexical and vector retrieval. */
const stop = new Set(['我','你','他','她','它','的','了','吗','呢','啊','是','在','和','与','也','都','有','这','那','什么','怎么','如何','是否','可以','请问','记得','我们','你们','他们','the','and','for','what','you','that','this','with','are']);
export function searchTerms(text: string, index = false): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  const parts = normalized.match(/[\p{Script=Han}]+|(?:(?![\p{Script=Han}])[\p{L}\p{N}_])+/gu) ?? [];
  const result: string[] = [];
  for (const part of parts) {
    const chars = Array.from(part);
    if (/^[\p{Script=Han}]+$/u.test(part)) {
      if (chars.length===1) { if(!stop.has(part)) result.push(part); continue; }
      for (let i = 0; i < chars.length; i++) {
        if (index && !stop.has(chars[i])) result.push(chars[i]);
        if (i + 1 < chars.length) {
          const pair=chars[i]+chars[i+1];
          if (!stop.has(chars[i]) && !stop.has(chars[i+1]) && !stop.has(pair)) result.push(pair);
        }
      }
    } else if (part.length <= 100 && !stop.has(part)) result.push(part);
  }
  return [...new Set(result)].slice(0, 128);
}
export function indexText(text: string): string { return searchTerms(text,true).join(' '); }
export function cosine(a: readonly number[], b: readonly number[]): number | null {
  if (!a.length || a.length !== b.length || a.length > 16384) return null;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return null;
    dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : null;
}
/** 30-day half-life with a non-zero floor: older information remains searchable. */
export function recencyWeight(at: number, now: number): number {
  const days = Math.max(0, now - at) / 86_400_000;
  return 0.3 + 0.7 * Math.pow(0.5, days / 30);
}
export function isHistoricalQuery(query: string): boolean {
  // A date cue permits old facts to be considered; it does not claim that the
  // fact actually applied on that date. The model still receives timestamps.
  const text=query.normalize('NFKC');
  return /以前|过去|之前|当时|曾经|原来|那时|昨天|前天|前两天|上(?:上|一|个)?(?:周|星期|礼拜|月|季度|年)|去年|前年|(?:19|20)\d{2}年(?:\d{1,2}月(?:\d{1,2}[日号])?)?|(?:19|20)\d{2}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|histor(?:y|ical)|previous|formerly|used to/i.test(text);
}
