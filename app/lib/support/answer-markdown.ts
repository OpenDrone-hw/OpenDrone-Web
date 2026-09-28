/**
 * The safe Markdown subset ChatFPV's own helper renders (ChatFPV
 * `worker/public/render.js` `markdown()` and `inline()`): paragraphs with line
 * breaks, `#` headings, `-`/`*` and numbered lists, pipe tables, fenced code,
 * inline code, `**bold**`, `*em*`/`_em_`, http(s) links and `[n]` citation
 * markers. It returns a tree of plain strings for React to render as text
 * nodes, so raw HTML in an answer is shown as text and never parsed.
 */

export type Inline =
  | {t: 'text'; v: string}
  | {t: 'strong'; v: string}
  | {t: 'em'; v: string}
  | {t: 'code'; v: string}
  | {t: 'link'; v: string; href: string}
  | {t: 'cite'; n: number};

export type Block =
  | {type: 'p'; lines: Inline[][]}
  | {type: 'h'; level: number; content: Inline[]}
  | {type: 'ul' | 'ol'; items: Inline[][]}
  | {type: 'table'; head: Inline[][]; rows: Inline[][][]}
  | {type: 'code'; text: string};

const SENTINEL_RE = /\s*(?:END[-_ ]OF[-_ ]ANSWER|<\|?\/?(?:end|eot|im_end|endoftext)\|?>|\[\/?END\]|<\/?answer>)\s*/gi;

function httpUrl(u: string): string | null {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : null;
  } catch {
    return null;
  }
}

// Order matters: code first, then links, citations, bold, emphasis (render.js order).
const INLINE_RE =
  /(`[^`\n]+`)|\[([^\]\n]{1,200})\]\((https?:\/\/[^\s()]+)\)|\[(\d{1,2})\](?!\()|\*\*([^*\n]+)\*\*|(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)|(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last?.t === 'text') last.v += v;
    else out.push({t: 'text', v});
  };
  let at = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const start = m.index ?? 0;
    push(text.slice(at, start));
    if (m[1]) out.push({t: 'code', v: m[1].slice(1, -1)});
    else if (m[2] !== undefined) {
      const href = httpUrl(m[3]);
      if (href) out.push({t: 'link', v: m[2], href});
      else push(m[0]);
    } else if (m[4] !== undefined) out.push({t: 'cite', n: Number(m[4])});
    else if (m[5] !== undefined) out.push({t: 'strong', v: m[5]});
    else if (m[7] !== undefined) {
      push(m[6]);
      out.push({t: 'em', v: m[7]});
    } else if (m[9] !== undefined) {
      push(m[8]);
      out.push({t: 'em', v: m[9]});
    }
    at = start + m[0].length;
  }
  push(text.slice(at));
  return out;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function isSepRow(line: string): boolean {
  if (!/^\s*\|.*\|\s*$/.test(line)) return false;
  return splitRow(line).every((c) => /^:?-{3,}:?$/.test(c));
}

export function parseAnswer(src: string): Block[] {
  const lines = String(src || '')
    .replace(SENTINEL_RE, (m) => (/\n/.test(m) ? '\n' : ' '))
    .replace(/[ \t]+$/gm, '')
    .split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  let list: {type: 'ul' | 'ol'; items: string[]} | null = null;
  const flushPara = () => {
    if (para.length) out.push({type: 'p', lines: para.map(parseInline)});
    para = [];
  };
  const flushList = () => {
    if (list) out.push({type: list.type, items: list.items.map(parseInline)});
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara();
      flushList();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      out.push({type: 'code', text: code.join('\n')});
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      flushPara();
      flushList();
      const head = splitRow(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(splitRow(lines[i]));
      i--;
      out.push({type: 'table', head: head.map(parseInline), rows: rows.map((r) => head.map((_, c) => parseInline(r[c] ?? '')))});
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      out.push({type: 'h', level: Math.min(6, h[1].length + 2), content: parseInline(h[2])});
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const type = ul ? 'ul' : 'ol';
      if (!list || list.type !== type) {
        flushList();
        list = {type, items: []};
      }
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ' ' + line.trim();
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out;
}
