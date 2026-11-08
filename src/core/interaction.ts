import { randomInt } from 'node:crypto';
import type { Interaction } from '../types.js';

type InteractionType = Interaction['type'];
const general: Record<InteractionType, string[]> = {
  pet: ['嗯，我在。', '你的手好暖和。', '这样待一会儿也不错。', '我听见啦。', '轻一点，嗯，这样就好。', '我在陪你呢。', '嗯，舒服。', '好啦，我知道是你。'],
  feed: ['谢谢，我收下啦。', '让我尝尝。', '这个看起来不错。', '嗯，我慢慢吃。', '好，我接住了。', '这份我收下啦。', '谢谢你给我留的这份。', '嗯，先尝一口。'],
};
const subdued: Record<InteractionType, string[]> = {
  pet: ['嗯……让我安静待一会儿。', '谢谢你陪着我。', '我在，慢慢来。'],
  feed: ['谢谢，我等一会儿尝尝。', '我先收好，谢谢。', '嗯，我知道啦。'],
};
const bright: Record<InteractionType, string[]> = {
  pet: ['嘿，碰到我啦。', '嗯，今天手感不错。', '再陪我待一会儿？'],
  feed: ['那我不客气啦。', '嗯，想尝尝这个。', '谢谢，我来啦。'],
};
const repeated: Record<InteractionType, string[]> = {
  pet: ['你还挺喜欢摸摸我的。', '嗯，还在摸呀。', '好啦，再待一会儿。'],
  feed: ['慢慢来，我接着呢。', '还有呀？谢谢你。', '嗯，我都看到了。'],
};

/** Select a short local response; a mood adds possibilities without forcing a reaction. */
export function interactionFeedback(type: InteractionType, mood: string, recent: Interaction[], now: number): string {
  const pool = [...general[type]];
  if (['担心', '沮丧', '不满'].includes(mood)) pool.push(...subdued[type]);
  if (['开心', '期待', '释然'].includes(mood)) pool.push(...bright[type]);
  // Only a consecutive, recent run of the same action changes the response pool.
  let streak = 0;
  for (const item of recent) {
    if (item.type !== type || now - item.createdAt > 5 * 60_000) break;
    streak++;
  }
  if (streak >= 3) pool.push(...repeated[type]);
  const lastFew = new Set(recent.filter(item => item.type === type).slice(0, 5).map(item => item.text));
  const candidates = pool.filter(line => !lastFew.has(line));
  // The general pool has at least eight entries, so excluding five cannot exhaust it.
  return candidates[randomInt(candidates.length)];
}
