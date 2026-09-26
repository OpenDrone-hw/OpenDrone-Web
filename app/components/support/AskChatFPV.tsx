import {useId, useState, type FormEvent} from 'react';
import type {AskResult} from '~/lib/support/chatfpv';

type Answer = Extract<AskResult, {ok: true}>['answer'];

/**
 * "Ask ChatFPV (AI)" on /support, above the ticket form (only while
 * CHATFPV_ASK_ENABLED is "1"). The question goes to POST /api/support/ask,
 * which asks ChatFPV server side. The answer is plain text with its
 * sources and the AI label. "Still need help? Open a ticket" hands the
 * question to the form; an answer ChatFPV hands off or abstains on, or
 * no answer at all, goes to the form straight away.
 */
export function AskChatFPV({onTicket}: {onTicket: (question: string) => void}) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = question.trim();
    if (q.length < 3 || busy) return;
    setBusy(true);
    setProblem(null);
    setAnswer(null);
    let body: AskResult | null = null;
    try {
      const res = await fetch('/api/support/ask', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({message: q}),
      });
      body = (await res.json()) as AskResult;
    } catch {
      body = null;
    }
    setBusy(false);
    if (body?.ok && !body.answer.handoff) {
      setAnswer(body.answer);
      return;
    }
    if (body && !body.ok && body.error === 'rate') {
      setProblem('Too many questions for now. Open a ticket and the team will answer.');
    }
    onTicket(q);
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
            placeholder="Which receiver protocol does the OpenFC F4 use?"
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
      {problem ? (
        <p role="status" className="sp-banner">
          {problem}
        </p>
      ) : null}
      {answer ? (
        <div className="sp-ask-answer" role="status" aria-live="polite" style={{display: 'grid', gap: 8, marginTop: 16}}>
          <p className="sp-hint">
            <strong>AI answer by ChatFPV.</strong> It can be wrong: check the sources.
          </p>
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
          <div className="sp-submit-row">
            <span>Still need help?</span>
            <button type="button" className="od-btn od-btn-secondary" onClick={() => onTicket(question.trim())}>
              Open a ticket
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
