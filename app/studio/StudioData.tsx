import {useEffect, useMemo, useState} from 'react';

/**
 * The Data tab: the configuration files under `content/` that are not copy.
 *
 * These hold numbers, dates and structure (batch targets, price steps, build
 * lists, team entries), which the Words tab deliberately refuses to edit
 * because a text box labelled "words" is how a target ends up as `"ten"`.
 * Here the whole file is edited as JSON and a save is refused until it
 * parses. Shape is checked by the tests: `npm test` before committing.
 */

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/__studio${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & {error?: string};
  if (!res.ok) throw new Error(json.error ?? `${res.status}`);
  return json;
}

/** What each file drives and where to see it. Unknown files still open. */
const ABOUT: Record<string, {what: string; url?: string}> = {
  'preorders.json': {
    what: 'Preorder batches, targets, price steps, ship and delivery dates. Also read by the order webhook and the launch script.',
    url: '/preorder',
  },
  'builds.json': {what: 'The 5" and 3" builds: parts, quantities and roles.', url: '/'},
  'accessories.json': {what: 'Accessories and spare parts shown with each product.', url: '/products/openframe'},
  'registrations.json': {what: 'Certifications and registrations (OSHWA and others).'},
  'team.json': {what: 'The team strip.', url: '/'},
  'contributors.json': {what: 'Contributor snapshot shown on product pages.'},
  'goals.json': {what: 'Goal meters. Also editable in the Goals tab.', url: '/roadmap'},
  'votes.json': {what: 'Vote tallies. Also editable in the Goals tab.', url: '/roadmap'},
  'theme.json': {what: 'Design-token overrides. Also editable in the Design tab.'},
};

export function StudioData({setStatus}: {setStatus: (s: string) => void}) {
  const [files, setFiles] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    api<{files: string[]}>('/list')
      .then((r) => {
        // Top-level files only: copy/ and products/ belong to the Words and
        // Chapters tabs.
        const data = r.files.filter((f) => !f.includes('/'));
        setFiles(data);
        setStatus(`${data.length} data files`);
        setCurrent(data.includes('preorders.json') ? 'preorders.json' : (data[0] ?? null));
      })
      .catch((e: unknown) => setStatus(`Could not list: ${(e as Error).message}`));
  }, [setStatus]);

  useEffect(() => {
    if (!current) return;
    api<{data: unknown}>('/read', {file: current})
      .then((r) => {
        const t = `${JSON.stringify(r.data, null, 2)}\n`;
        setText(t);
        setSaved(t);
      })
      .catch((e: unknown) => setStatus(`Could not read: ${(e as Error).message}`));
    // Only when the selection changes; setStatus is stable for the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const parsed = useMemo((): {ok: true; data: unknown} | {ok: false; error: string} => {
    try {
      return {ok: true, data: JSON.parse(text)};
    } catch (e) {
      return {ok: false, error: (e as Error).message};
    }
  }, [text]);

  const dirty = text !== saved;

  const save = async () => {
    if (!current || !parsed.ok) return;
    try {
      await api('/write', {file: current, data: parsed.data});
      const t = `${JSON.stringify(parsed.data, null, 2)}\n`;
      setText(t);
      setSaved(t);
      setStatus(`Saved content/${current}. Run npm test before committing.`);
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  const about = current ? ABOUT[current] : undefined;

  return (
    <div className="studio-grid is-two">
      <aside className="studio-rail">
        <h2>content/</h2>
        <ul className="studio-pages">
          {files.map((f) => (
            <li key={f}>
              <button
                type="button"
                className={current === f ? 'is-on' : undefined}
                onClick={() => {
                  if (dirty && !window.confirm('Discard unsaved changes?')) return;
                  setCurrent(f);
                }}
              >
                {f.replace(/\.json$/, '')}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="studio-stage">
        <div className="studio-urlbar">
          <span className="studio-hero-note" style={{marginLeft: 0}}>
            {current ? `content/${current}` : 'No file selected'}
          </span>
          {about?.url ? (
            <a className="studio-hero-note" href={about.url} target="_blank" rel="noreferrer">
              Open {about.url}
            </a>
          ) : null}
          <div className="studio-actions" style={{marginLeft: 'auto'}}>
            <button type="button" onClick={() => setText(saved)} disabled={!dirty}>
              Revert
            </button>
            <button
              type="button"
              className="is-primary"
              onClick={() => void save()}
              disabled={!dirty || !parsed.ok}
            >
              {dirty ? 'Save' : 'Saved'}
            </button>
          </div>
        </div>

        <p className="studio-token-note" style={{margin: 12}}>
          {parsed.ok ? (about?.what ?? 'Configuration file.') : `Not valid JSON: ${parsed.error}`}
        </p>

        <textarea
          className="studio-doc"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
      </main>
    </div>
  );
}
