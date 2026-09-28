/* eslint-disable react/no-array-index-key -- a parsed answer is a static tree: position is its identity. */
import type {ReactNode} from 'react';
import {parseAnswer, type Inline} from '~/lib/support/answer-markdown';

type Citation = {n: number; url: string; title?: string};

function inline(parts: Inline[], cites: Map<number, Citation>): ReactNode[] {
  return parts.map((p, i) => {
    switch (p.t) {
      case 'strong':
        return <strong key={i}>{p.v}</strong>;
      case 'em':
        return <em key={i}>{p.v}</em>;
      case 'code':
        return <code key={i}>{p.v}</code>;
      case 'link':
        return (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow">
            {p.v}
          </a>
        );
      case 'cite': {
        const c = cites.get(p.n);
        return c ? (
          <a key={i} href={c.url} target="_blank" rel="noopener noreferrer nofollow" aria-label={`Source ${p.n}${c.title ? `: ${c.title}` : ''}`}>
            [{p.n}]
          </a>
        ) : (
          `[${p.n}]`
        );
      }
      default:
        return p.v;
    }
  });
}

/**
 * A ChatFPV answer rendered with the helper's safe Markdown subset
 * (`answer-markdown.ts`). Every piece is a React text node: raw HTML in the
 * answer stays text.
 */
export function AnswerMarkdown({text, citations = []}: {text: string; citations?: Citation[]}) {
  const cites = new Map(citations.map((c) => [c.n, c]));
  return (
    <div className="sp-ask-md" dir="auto" style={{display: 'grid', gap: 8}}>
      {parseAnswer(text).map((b, i) => {
        switch (b.type) {
          case 'p':
            return (
              <p key={i}>
                {b.lines.map((l, j) => (
                  <span key={j}>
                    {j ? <br /> : null}
                    {inline(l, cites)}
                  </span>
                ))}
              </p>
            );
          case 'h': {
            const H = `h${b.level}` as 'h3' | 'h4' | 'h5' | 'h6';
            return <H key={i}>{inline(b.content, cites)}</H>;
          }
          case 'ul':
          case 'ol': {
            const L = b.type;
            return (
              <L key={i} style={{paddingLeft: '1.25em', listStyle: b.type === 'ul' ? 'disc' : 'decimal', display: 'grid', gap: 4}}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, cites)}</li>
                ))}
              </L>
            );
          }
          case 'table':
            return (
              <div key={i} style={{overflowX: 'auto'}}>
                <table style={{borderCollapse: 'collapse'}}>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} style={{textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid currentColor'}}>
                          {inline(c, cites)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k} style={{padding: '4px 8px'}}>
                            {inline(c, cites)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'code':
            return (
              <pre key={i} style={{overflowX: 'auto', whiteSpace: 'pre'}}>
                <code>{b.text}</code>
              </pre>
            );
        }
      })}
    </div>
  );
}
/* eslint-enable react/no-array-index-key */
