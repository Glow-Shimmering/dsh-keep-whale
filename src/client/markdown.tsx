import { marked, type Token, type Tokens } from 'marked';
import type { ReactNode } from 'react';

/** Only open absolute web links. Raw HTML and non-web protocols are never executed. */
export function safeMessageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

// Marked's lexer preserves character references. Decode the common references
// as text, never by parsing HTML; React then escapes the resulting string.
function plain(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/gi, (raw, entity: string) => {
    const key = entity.toLowerCase();
    if (key[0] !== '#') return named[key] ?? raw;
    const value = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return value >= 0x20 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '\ufffd';
  });
}

/** Bind to the React instance supplied by DSH; never emit or parse raw HTML. */
export function createMessageText(React: typeof import('react')) {
  const h = React.createElement;
  function renderTokens(tokens: Token[], depth = 0): ReactNode[] {
    if (depth > 24) return tokens.map(token => token.raw);
    const children = (token: { tokens?: Token[]; text?: string }) =>
      Array.isArray(token.tokens) ? renderTokens(token.tokens, depth + 1) : [plain(token.text || '')];
    return tokens.map((token, i): ReactNode => {
      const key = `token-${depth}-${i}`;
      switch (token.type) {
        case 'space': return null;
        case 'paragraph': return h('p', { key }, ...children(token as Tokens.Paragraph));
        case 'heading': {
          const heading = token as Tokens.Heading;
          const level = Math.min(6, Math.max(1, heading.depth));
          return h(`h${level}`, { key }, ...children(heading));
        }
        case 'strong': return h('strong', { key }, ...children(token as Tokens.Strong));
        case 'em': return h('em', { key }, ...children(token as Tokens.Em));
        case 'del': return h('del', { key }, ...children(token as Tokens.Del));
        case 'br': return h('br', { key });
        case 'hr': return h('hr', { key });
        case 'blockquote': return h('blockquote', { key }, ...children(token as Tokens.Blockquote));
        case 'codespan': return h('code', { key }, (token as Tokens.Codespan).text);
        case 'code': return h('pre', { key }, h('code', null, (token as Tokens.Code).text));
        case 'checkbox': return h('span', { key, 'aria-label': (token as Tokens.Checkbox).checked ? '已选中' : '未选中' }, (token as Tokens.Checkbox).checked ? '☑ ' : '☐ ');
        case 'escape': return plain((token as Tokens.Escape).text);
        case 'html': return token.raw; // React treats this strictly as text.
        case 'image': {
          const image = token as Tokens.Image;
          return h('span', { key, className: 'kw-markdown-image-alt' }, image.text ? `图片：${plain(image.text)}` : '[图片]');
        }
        case 'link': {
          const link = token as Tokens.Link;
          const href = safeMessageUrl(link.href);
          return href
            ? h('a', { key, href, title: link.title || undefined, target: '_blank', rel: 'noopener noreferrer' }, ...children(link))
            : h('span', { key }, ...children(link));
        }
        case 'list': {
          const list = token as Tokens.List;
          return h(list.ordered ? 'ol' : 'ul', { key, ...(list.ordered && typeof list.start === 'number' ? { start: list.start } : {}) },
            ...list.items.map((item, j) => h('li', { key: `${key}-item-${j}` }, ...renderTokens(item.tokens, depth + 1))));
        }
        case 'table': {
          const table = token as Tokens.Table;
          const cells = (row: Tokens.TableCell[], tag: 'th' | 'td', rowKey: string) => row.map((cell, j) =>
            h(tag, { key: `${rowKey}-cell-${j}`, ...(cell.align ? { style: { textAlign: cell.align } } : {}) }, ...renderTokens(cell.tokens, depth + 1)));
          return h('div', { key, className: 'kw-markdown-table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, ...cells(table.header, 'th', `${key}-head`))),
            h('tbody', null, ...table.rows.map((row, j) => h('tr', { key: `${key}-row-${j}` }, ...cells(row, 'td', `${key}-row-${j}`))))));
        }
        case 'text': {
          const text = token as Tokens.Text;
          return Array.isArray(text.tokens) ? renderTokens(text.tokens, depth + 1) : plain(text.text);
        }
        case 'def': return null;
        default: return token.raw;
      }
    });
  }
  function MessageText({ text, role }: { text: string; role: 'user' | 'assistant' }) {
    if (role === 'user') return h('div', { className: 'kw-message-plain' }, text);
    try {
      // Very long model output remains readable without allowing a pathological
      // document to monopolise the UI during streaming.
      const contents = text.length <= 200_000 ? renderTokens(marked.lexer(text, { gfm: true, breaks: true })) : [text];
      return h('div', { className: 'kw-markdown' }, ...contents);
    } catch {
      // An incomplete streamed fragment or unusual syntax must stay visible.
      return h('div', { className: 'kw-markdown' }, text);
    }
  }
  return MessageText;
}
