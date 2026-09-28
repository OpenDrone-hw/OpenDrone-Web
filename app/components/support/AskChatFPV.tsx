import {useEffect, useId, useRef, useState, type FormEvent} from 'react';
import type {AskProductCard, AskResult} from '~/lib/support/chatfpv';
import {ProductPods, type ProductPodItem} from '~/components/ProductPods';
import {trackEvent} from '~/lib/growth/plausible';
import {copyText} from '~/lib/copy';
import {AnswerMarkdown} from './AnswerMarkdown';

type Answer = Extract<AskResult, {ok: true}>['answer'];

function podItem(p: AskProductCard): ProductPodItem {
  return {
    key: p.handle,
    to: p.href,
    title: p.title,
    imageUrl: p.image,
    price: {amount: p.price.amount, currencyCode: p.price.currencyCode},
    buy: p.addToCartHref ? {href: p.addToCartHref, product: p.handle, available: p.available} : undefined,
  };
}

/**
 * Why the Ask box swapped to the ticket form instead of showing an answer,
 * shown by `support.tsx` above the form: the box itself unmounts on the
 * swap, so a message that lived only in its own state would vanish with it.
 */
export type AskReason = {message: string; url?: string};

const REASON_TEXT: Record<Exclude<AskResult, {ok: true}>['error'], string> = {
  unavailable: "ChatFPV can't answer right now.",
  forbidden: "That request wasn't allowed from here.",
  invalid: "That question couldn't be sent; try rephrasing it.",
  rate: 'Too many questions for now.',
};

/**
 * One `text/event-stream` frame (`app/lib/support/chatfpv.ts`
 * `handleAskStream`: `event: <type>\ndata: <json>\n\n`) parsed to its event
 * name and JSON payload, or undefined for an incomplete or malformed frame -
 * a chunk boundary mid-line must never be parsed as JSON.
 */
function parseAskFrame(block: string): {type: string; data: unknown} | undefined {
  let type = '';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) type = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!type || !data) return undefined;
  try {
    return {type, data: JSON.parse(data)};
  } catch {
    return undefined;
  }
}

/**
 * Reads `POST /api/support/ask/stream`'s SSE body: `onStatus` fires with
 * each ChatFPV progress line while it works, `onDelta` with each answer
 * chunk, and the returned promise resolves
 * with the `AskResult` its one `done` event carries. Resolves null when the
 * stream ends (a dropped connection, or the request was aborted) before a
 * `done` event ever arrived, same as a network failure.
 */
export async function readAskStream(
  res: Response,
  onDelta: (text: string) => void,
  onStatus?: (text: string) => void,
): Promise<AskResult | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const dec = new TextDecoder();
  let buf = '';
  let result: AskResult | null = null;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    buf += dec.decode(value, {stream: true});
    const blocks = buf.split('\n\n');
    buf = blocks.pop() ?? '';
    for (const block of blocks) {
      const frame = parseAskFrame(block);
      if (!frame) continue;
      if (frame.type === 'delta') {
        const text = (frame.data as {text?: unknown} | null)?.text;
        if (typeof text === 'string' && text) onDelta(text);
      } else if (frame.type === 'status') {
        const text = (frame.data as {text?: unknown} | null)?.text;
        if (typeof text === 'string' && text) onStatus?.(text);
      } else if (frame.type === 'done') {
        result = frame.data as AskResult;
      }
    }
    if (result) break;
  }
  return result;
}

/**
 * "Ask ChatFPV (AI)" on /support, above the ticket form (only while
 * CHATFPV_ASK_ENABLED is "1"). The question goes to POST /api/support/ask,
 * which asks ChatFPV server side. The answer renders ChatFPV's safe Markdown
 * subset (`AnswerMarkdown`, text nodes only) with its sources and the AI label. "Still need help? Open a ticket" hands the
 * question to the form; an answer ChatFPV hands off or abstains on, or no
 * answer at all, goes to the form straight away, with `onTicket`'s reason
 * shown above it so the swap never looks like a broken page.
 */
export function AskChatFPV({
  onTicket,
  product,
}: {
  onTicket: (question: string, reason?: AskReason) => void;
  product?: string;
}) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [status, setStatus] = useState('');
  const id = useId();
  const abortRef = useRef<AbortController | null>(null);

  // A visitor who navigates away or closes the tab mid-stream must not leave
  // the fetch (and the storefront's own ChatFPV call it drives) running.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = question.trim();
    if (q.length < 3 || busy) return;
    setBusy(true);
    setAnswer(null);
    trackEvent('chatfpv_ask_submit');
    const controller = new AbortController();
    abortRef.current = controller;
    let body: AskResult | null = null;
    try {
      const res = await fetch('/api/support/ask/stream', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'text/event-stream'},
        body: JSON.stringify({message: q, ...(product ? {product} : {})}),
        signal: controller.signal,
      });
      if (res.headers.get('Content-Type')?.startsWith('text/event-stream')) {
        // An early refusal or a fixed-rule answer is plain JSON (the else
        // branch); a ChatFPV answer streams (handleAskStream's doc comment).
        // Its status lines show on the button while ChatFPV works; the text
        // grows as it arrives; the final shaping (citations, uncertain, buy
        // cards, or a handoff swap to the ticket form) happens once `done`
        // settles it.
        let streamed = '';
        body = await readAskStream(
          res,
          (text) => {
            streamed += text;
            setAnswer({text: streamed, citations: [], outcome: 'answered', handoff: false});
          },
          setStatus,
        );
      } else {
        body = (await res.json()) as AskResult;
      }
    } catch {
      body = null;
    }
    abortRef.current = null;
    setBusy(false);
    setStatus('');
    const outcome = body?.ok ? body.answer.outcome : 'error';
    trackEvent('chatfpv_ask_result', {props: {outcome}});
    if (body?.ok && !body.answer.handoff) {
      setAnswer(body.answer);
      return;
    }
    setAnswer(null);
    trackEvent('chatfpv_ticket_after_ask');
    if (body?.ok && body.answer.handoff) {
      onTicket(q, {message: body.answer.reason || REASON_TEXT.unavailable, ...(body.answer.url ? {url: body.answer.url} : {})});
      return;
    }
    const message = body && !body.ok ? body.message || REASON_TEXT[body.error] : REASON_TEXT.unavailable;
    onTicket(q, {message});
  }

  function openTicket() {
    trackEvent('chatfpv_ticket_after_ask');
    onTicket(question.trim());
  }

  return (
    <section className="sp-card sp-ask" aria-labelledby={`${id}-title`}>
      <h2 className="sp-card-title" id={`${id}-title`}>
        Ask ChatFPV (AI)
      </h2>
      <p className="sp-hint">
        An instant answer from ChatFPV, an AI assistant for FPV and OpenDrone hardware, with its sources. For orders,
        returns and warranty, open a ticket.
      </p>
      <p className="sp-hint sp-ask-privacy">
        {copyText('support.ask_privacy_notice') ??
          "Your question goes to ChatFPV, Incutec's AI assistant. We remove emails, phone numbers, card numbers, IBANs and similar identifiers before sending it, but not your name or order number, so please leave those out yourself. Conversations that do not become a ticket are deleted after 90 days idle."}
      </p>
      <form className="sp-form" onSubmit={(e) => void ask(e)}>
        <label className="sp-field">
          <span className="sp-label">Your question</span>
          <textarea
            name="question"
            rows={3}
            maxLength={1000}
            dir="auto"
            className="sp-input sp-textarea"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Which receiver protocol does the OpenRX use?"
          />
        </label>
        <div className="sp-submit-row">
          <button type="submit" className="od-btn od-btn-primary" disabled={busy || question.trim().length < 3}>
            {busy ? `${status || 'Asking'}…` : 'Ask ChatFPV'}
          </button>
          <a
            href="/support?ticket=1"
            className="od-btn od-btn-secondary"
            onClick={(e) => {
              e.preventDefault();
              onTicket(question.trim());
            }}
          >
            Open a ticket instead
          </a>
        </div>
      </form>
      {answer ? (
        <div className="sp-ask-answer" role="status" aria-live="polite" style={{display: 'grid', gap: 8, marginTop: 16}}>
          <p className="sp-hint">
            <strong>AI answer by ChatFPV.</strong> It can be wrong: check the sources.
          </p>
          {answer.uncertain ? (
            <p className="sp-banner" role="note">
              ChatFPV isn&apos;t confident about this one. Check the sources below, or open a ticket.
            </p>
          ) : null}
          <AnswerMarkdown text={answer.text} citations={answer.citations} />
          {answer.citations.length ? (
            <ol className="sp-links" aria-label="Sources">
              {answer.citations.map((c) => (
                <li key={`${c.n}-${c.url}`}>
                  [{c.n}]{' '}
                  <a href={c.url} target="_blank" rel="noopener noreferrer nofollow">
                    {c.title}
                  </a>
                  {c.source ? <span className="sp-hint"> · {c.source}</span> : null}
                </li>
              ))}
            </ol>
          ) : null}
          {answer.products?.length ? (
            <div style={{marginTop: 4}}>
              <ProductPods items={answer.products.map(podItem)} layout="row" />
            </div>
          ) : null}
          <div className="sp-submit-row">
            <span>Still need help?</span>
            <button
              type="button"
              className={answer.uncertain ? 'od-btn od-btn-primary' : 'od-btn od-btn-secondary'}
              onClick={openTicket}
            >
              Open a ticket
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
