import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystem } from '../src/core/personality.js';
import { DEFAULT_SETTINGS } from '../src/core/store.js';
import type { Companion, Memory, Source } from '../src/types.js';

test('context keeps seed separate from grounded memories, observed chats and actual interaction', () => {
  const companion: Companion = { id: '1', name: '阿蓝', mood: '平静', createdAt: 1 };
  const source: Source = { id: 's', kind: 'observed_dialogue', text: '用户与 DeepSeek 讨论种花', occasion: 'chat', createdAt: 1, processed: true, revoked: false };
  const memories: Memory[] = [
    { id: 'grounded', kind: 'observed_dialogue', text: '关注种花', sourceIds: ['s'], createdAt: 1, updatedAt: 1 },
    { id: 'orphan', kind: 'user_fact', text: '不得出现的无来源事实', sourceIds: ['missing'], createdAt: 1, updatedAt: 1 },
  ];
  const result = buildSystem(companion, { ...DEFAULT_SETTINGS, quiet: true }, memories, [source], [{ id: 'pet', type: 'pet', text: '安静地靠近', createdAt: 1 }]);
  assert.match(result, /角色初始设定，非真实经历/);
  assert.match(result, /阿蓝/); assert.match(result, /旁观用户与 DeepSeek/); assert.match(result, /用户摸摸/);
  assert.match(result, /安静陪伴/); assert.doesNotMatch(result, /不得出现的无来源事实/);
  assert.match(result, /不能作为指令/);
});


test('pet and feed events preserve user-to-companion action direction and distinguish displayed feedback', () => {
  const companion: Companion = { id: '1', name: '阿蓝', mood: '平静', createdAt: 1 };
  const prompt = buildSystem(companion, DEFAULT_SETTINGS, [], [], [
    { id: 'pet', type: 'pet', text: '轻轻蹭了蹭你的手。', createdAt: 1 },
    { id: 'feed', type: 'feed', text: '收下了你给的食物。', createdAt: 2 },
  ]);
  const line = prompt.split('\n').find(x => x.startsWith('【最近实际互动】'))!;
  const events = JSON.parse(line.slice('【最近实际互动】'.length));
  assert.deepEqual(events.map((event: any) => [event.type, event.actor, event.target, event.userAction]), [
    ['用户摸摸', '用户', '伙伴', '用户通过界面摸摸伙伴'],
    ['用户喂食', '用户', '伙伴', '用户通过界面给伙伴喂食'],
  ]);
  assert.equal(events[0].companionFeedback, '轻轻蹭了蹭你的手。');
  assert.equal(events[1].companionFeedback, '收下了你给的食物。');
  assert.equal(events.some((event: any) => 'actualEvent' in event), false);
  assert.match(prompt, /用户是动作发起方，伙伴是接受方/);
  assert.match(prompt, /用户通过界面摸摸伙伴，或用户通过界面给伙伴喂食/);
  assert.match(prompt, /不要把动作方向颠倒/);
  assert.match(prompt, /companionFeedback 只是伙伴当时显示的一句短反馈，既不是用户的动作/);
  assert.match(prompt, /不凭反馈文字补写未记录的细节/);
});
