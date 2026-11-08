import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createMessageText, safeMessageUrl } from '../src/client/markdown.js';

const MessageText = createMessageText(React);
type Node = { type: unknown; props: Record<string, any> };
function descendants(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!React.isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...descendants(node.props.children)];
}
function visibleText(value: unknown): string {
  if (Array.isArray(value)) return value.map(visibleText).join('');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (React.isValidElement(value)) return visibleText((value.props as {children?:unknown}).children);
  return '';
}

test('assistant markdown supports structured content and user message remains plain text', () => {
  const text = '# 标题\n\n普通 **强调** 与 `代码`\n\n- 第一条\n- 第二条\n\n> 引用\n\n```js\nif (a < b) return 1;\n```\n\n| 名称 | 值 |\n| --- | --- |\n| 一 | **二** |';
  const tree = MessageText({ text, role: 'assistant' });
  const types = descendants(tree).map(n => n.type);
  for (const name of ['h1', 'p', 'strong', 'ul', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'th', 'td']) assert.ok(types.includes(name), `missing ${name}`);
  assert.match(visibleText(tree), /if \(a < b\) return 1/);
  const user = MessageText({ text, role: 'user' });
  assert.equal(descendants(user).length, 1);
  assert.equal((user.props as {className:string}).className, 'kw-message-plain');
  assert.equal(visibleText(user), text);
});

test('HTML, protocol tricks and images never become executable or loaded nodes', () => {
  const text = '<script>alert(1)</script>\n\n<img src="https://tracker.invalid/p.png" onerror="alert(2)">\n\n![secret](https://tracker.invalid/i.png)\n\n[bad](javascript:alert(1)) [data](data:text/html,bad) [file](file:///tmp/test) [safe](https://example.com/path?q=1)';
  const tree = MessageText({ text, role: 'assistant' });
  const nodes = descendants(tree);
  assert.ok(nodes.every(n => !['script','img','iframe','object','embed','style'].includes(String(n.type))));
  assert.ok(nodes.every(n => !('dangerouslySetInnerHTML' in n.props)));
  assert.ok(nodes.every(n => !('onError' in n.props) && !('src' in n.props)));
  const anchors = nodes.filter(n => n.type === 'a');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].props.href, 'https://example.com/path?q=1');
  assert.equal(anchors[0].props.target, '_blank');
  assert.match(anchors[0].props.rel, /(?:^|\s)noopener(?:\s|$)/);
  assert.match(anchors[0].props.rel, /(?:^|\s)noreferrer(?:\s|$)/);
  assert.match(visibleText(tree), /<script>alert\(1\)<\/script>/);
});

test('URL policy rejects script, local, relative, control and whitespace obfuscation', () => {
  for (const url of ['javascript:alert(1)', 'jAvAsCrIpT:alert(1)', 'java\nscript:alert(1)', 'data:text/html,x', 'file:///tmp/x', '//evil.example/x', '/relative', ' https://example.com', 'https://example.com\n']) assert.equal(safeMessageUrl(url), null, url);
  assert.equal(safeMessageUrl('http://example.com'), 'http://example.com/');
  assert.equal(safeMessageUrl('https://example.com/path'), 'https://example.com/path');
});

test('partial streamed markdown and entities remain visible as escaped text', () => {
  for (const text of ['**尚未结束', '[链接](https://example.com', '```js\nif (a < b)', '| a | b |\n| --- |', '文字 &lt;script&gt; 与 &amp;']) {
    const tree = MessageText({ text, role: 'assistant' });
    assert.ok(visibleText(tree).length > 0);
    assert.ok(descendants(tree).every(n => !['script','img'].includes(String(n.type)) && !('dangerouslySetInnerHTML' in n.props)));
  }
  const decoded = MessageText({ text: '&lt;script&gt; &amp;', role: 'assistant' });
  assert.equal(visibleText(decoded), '<script> &');
  assert.ok(descendants(decoded).every(n => n.type !== 'script'));
});
