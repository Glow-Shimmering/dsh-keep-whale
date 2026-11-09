import type { Ledger } from '../types.js';

/** Manual embedding requests are charged separately from background indexing. */
export function manualEmbeddingCalls(entries: Ledger[]): Ledger[] {
  return entries.filter(entry => !entry.background && !!entry.details);
}

export interface JobCostGroup {
  unit: string; actual: number; reserved: number; uncertain: number;
  estimated: number; hasEstimated:boolean;
  hasActual: boolean; hasReserved: boolean; hasUncertain: boolean; exceeded: boolean;
}
/** An over-reservation with known actual usage is not an unknown charge. */
export function summarizeJobCosts(entries: Ledger[]): JobCostGroup[] {
  const groups = new Map<string, JobCostGroup>();
  for (const entry of entries) {
    const unit = entry.unit || '单位未记录';
    const group = groups.get(unit) || {unit,actual:0,reserved:0,uncertain:0,estimated:0,hasEstimated:false,hasActual:false,hasReserved:false,hasUncertain:false,exceeded:false};
    if (entry.actual !== null && entry.status !== 'reserved') {
      group.actual += entry.actual; group.hasActual = true;
      if (entry.status === 'uncertain' && !entry.budgetAcknowledgedAt) group.exceeded = true;
    } else if (entry.status === 'reserved') { group.reserved += entry.reserved; group.hasReserved = true; }
    else if(entry.budgetAcknowledgedAt) { group.estimated += entry.reserved; group.hasEstimated=true; }
    else { group.uncertain += entry.reserved; group.hasUncertain = true; }
    groups.set(unit, group);
  }
  return [...groups.values()];
}

export function budgetConfirmation(entry:Ledger):string {
  const amount=entry.actual??entry.reserved, unit=entry.unit||'未记录单位';
  const basis=entry.actual===null?`将预留的 ${amount} ${unit} 作为本地预算暂记，实际费用仍未核实，可能高于暂记金额。`:`确认这笔已知的 ${amount} ${unit} 费用，保留超出预留的原始记录。`;
  return `${basis}\n此操作不会修改供应商账单或把未知费用改成已核实。全部 B 站阻塞费用处理完后，未来 B 站任务可按设置继续运行并产生新费用；聊天、记忆整理和主动联系不受这项预算限制；插件按暂记金额检查每日预算，不能保证供应商实际总扣费不超过预算。\n确认处理 ${entry.day} 的这笔费用？`;
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
