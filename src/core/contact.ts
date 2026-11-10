/** Admission windows prevent bursts; reaching one never schedules a message. */
export const CONTACT_GAP_MS=10*60_000;
export const BILI_SHARE_GAP_MS=45*60_000;
export const UNANSWERED_CONTACT_GAP_MS=3*60*60_000;
export interface ContactTimestamps {lastProactiveAt:number|null;lastUserAt:number|null}
export function contactWindow(times:ContactTimestamps,kind:'general'|'bilibili',now=Date.now()) {
  const last=times.lastProactiveAt;
  const awaitingReply=last!==null&&(times.lastUserAt===null||times.lastUserAt<=last);
  const gap=kind==='bilibili'?(awaitingReply?UNANSWERED_CONTACT_GAP_MS:BILI_SHARE_GAP_MS):CONTACT_GAP_MS;
  const nextAt=last===null?null:last+gap;
  return {allowed:nextAt===null||now>=nextAt,awaitingReply,nextAt};
}
