import {useId, useState, type FormEvent} from 'react';
import type {AskProductCard, AskResult} from '~/lib/support/chatfpv';
import {ProductPods, type ProductPodItem} from '~/components/ProductPods';
import {trackEvent} from '~/lib/growth/plausible';

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
 * "Ask ChatFPV (AI)" on /support, above the ticket form (only while
 * CHATFPV_ASK_ENABLED is "1"). The question goes to POST /api/support/ask,
 * which asks ChatFPV server side. The answer is plain text with its
 * sources and the AI label. "Still need help? Open a ticket" hands the
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
  const id = useId();

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = question.trim();
    if (q.length < 3 || busy) return;
    setBusy(true);
    setAnswer(null);
    trackEvent('chatfpv_ask_submit');
    let body: AskResult | null = null;
    try {
      const res = await fetch('/api/support/ask', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({message: q, ...(product ? {product} : {})}),
      });
      body = (await res.json()) as AskResult;
    } catch {
      body = null;
    }
    setBusy(false);
    const outcome = body?.ok ? body.answer.outcome : 'error';
    trackEvent('chatfpv_ask_result', {props: {outcome}});
    if (body?.ok && !body.answer.handoff) {
      setAnswer(body.answer);
      return;
    }
    trackEvent('chatfpv_ticket_after_ask');
    if (body?.ok && body.answer.handoff) {
      onTicket(q, {message: body.answer.reason || REASON_TEXT.unavailable, ...(body.answer.url ? {url: body.answer.url} : {})});
      return;
    }
    const message = body && !body.ok ? REASON_TEXT[body.error] : REASON_TEXT.unavailable;
    onTicket(q, {message});
  }

  function openTicket() {
    trackEvent('chatfpv_ticket_after_ask');
    onTicket(question.trim());
  }

  const paragraphs = answer ? answer.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean) : [];

  return (
    <section className="sp-card sp-ask" aria-labelledby={`${id}-title`}>
      <h2 className="sp-card-title" id={`${id}-title`}>
        Ask ChatFPV (AI)
      </h2>
      <p className="sp-hint">
        An instant answer from ChatFPV, an AI assistant for FPV and OpenDrone hardware, with its sources. For orders,
        returns and warranty, open a ticket.
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
            {busy ? 'Asking…' : 'Ask ChatFPV'}
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
          {paragraphs.map((p) => (
            <p key={`${p.length}:${p.slice(0, 40)}`} dir="auto" style={{whiteSpace: 'pre-line'}}>
              {p}
            </p>
          ))}
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
