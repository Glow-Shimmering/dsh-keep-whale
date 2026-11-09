import type { Ledger } from '../types.js';

/** Manual embedding requests are charged separately from background indexing. */
export function manualEmbeddingCalls(entries: Ledger[]): Ledger[] {
  return entries.filter(entry => !entry.background && !!entry.details);
}

export interface JobCostGroup {
  unit: string; actual: number; reserved: number; uncertain: number;
  hasActual: boolean; hasReserved: boolean; hasUncertain: boolean; exceeded: boolean;
}
/** An over-reservation with known actual usage is not an unknown charge. */
export function summarizeJobCosts(entries: Ledger[]): JobCostGroup[] {
  const groups = new Map<string, JobCostGroup>();
  for (const entry of entries) {
    const unit = entry.unit || '单位未记录';
    const group = groups.get(unit) || {unit,actual:0,reserved:0,uncertain:0,hasActual:false,hasReserved:false,hasUncertain:false,exceeded:false};
    if (entry.actual !== null && entry.status !== 'reserved') {
      group.actual += entry.actual; group.hasActual = true;
      if (entry.status === 'uncertain') group.exceeded = true;
    } else if (entry.status === 'reserved') { group.reserved += entry.reserved; group.hasReserved = true; }
    else { group.uncertain += entry.reserved; group.hasUncertain = true; }
    groups.set(unit, group);
  }
  return [...groups.values()];
}

/** Chat recall is part of the request that caused it; attempts remain separate records. */
export function jobLedgerEntries(jobId: string, entries: Ledger[]): Ledger[] {
  return entries.filter(entry => entry.jobId === jobId || entry.jobId === `${jobId}:recall` || entry.jobId.startsWith(`${jobId}:attempt:`));
}
export function manualEmbeddingLabel(jobId: string): string {
  if (jobId.startsWith('embedding-check:')) return '连接检查';
  if (jobId.endsWith(':recall')) return '对话回想';
  return '语义搜索';
}
