import {useCallback, useEffect, useState} from 'react';

/**
 * The Docs tab: every page that is a document rather than a page made of
 * strings, edited as Markdown. The legal pages in three languages, the
 * newsletter posts and the learn articles.
 *
 * The storefront is the authoring source for all of them, so every file is
 * editable. A new newsletter post starts as a copy of `_template.md` with
 * `published: false`, which keeps it off the site until the front matter
 * says otherwise.
 */

type Doc = {
  file: string;
  group: string;
  name: string;
};

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

const title = (name: string) => name.replace(/\.md$/, '').replace(/-/g, ' ');

/** The site URL a document renders at, when it has one. */
function pageUrl(doc: Doc): string | null {
  const slug = doc.name.replace(/\.md$/, '');
  if (slug.startsWith('_')) return null;
  if (doc.file.startsWith('content/posts/')) return `/newsletter/${slug}`;
  if (doc.file.startsWith('app/content/learn/')) return `/learn/${slug}`;
  return null;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function StudioDocs({setStatus}: {setStatus: (s: string) => void}) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [current, setCurrent] = useState<Doc | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [newSlug, setNewSlug] = useState('');

  const list = useCallback(
    (select?: string) =>
      api<{docs: Doc[]}>('/docs')
        .then((r) => {
          setDocs(r.docs);
          setStatus(`${r.docs.length} documents`);
          const pick = r.docs.find((d) => d.file === select) ?? r.docs[0];
          if (pick) setCurrent(pick);
        })
        .catch((e: unknown) => setStatus(`Could not list: ${(e as Error).message}`)),
    [setStatus],
  );

  useEffect(() => {
    void list();
  }, [list]);

  useEffect(() => {
    if (!current) return;
    api<{text: string}>('/read-text', {file: current.file})
      .then((r) => {
        setText(r.text);
        setSaved(r.text);
      })
      .catch((e: unknown) => setStatus(`Could not read: ${(e as Error).message}`));
    // Only when the selection changes; setStatus is stable for the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.file]);

  const dirty = text !== saved;

  const save = async () => {
    if (!current) return;
    try {
      await api('/write-text', {file: current.file, text});
      setSaved(text);
      setStatus(`Saved ${current.file}`);
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  const createPost = async () => {
    const slug = newSlug.trim();
    if (!SLUG.test(slug)) {
      setStatus('A post name is lowercase letters, digits and hyphens');
      return;
    }
    const file = `content/posts/${slug}.md`;
    if (docs.some((d) => d.file === file)) {
      setStatus(`${file} already exists`);
      return;
    }
    try {
      const {text: template} = await api<{text: string}>('/read-text', {
        file: 'content/posts/_template.md',
      });
      const today = new Date().toISOString().slice(0, 10);
      await api('/write-text', {
        file,
        text: template.replace(/^date: .*$/m, `date: ${today}`),
      });
      setNewSlug('');
      setStatus(`Created ${file}, unpublished`);
      await list(file);
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  const groups = [...new Set(docs.map((d) => d.group))];
  const url = current ? pageUrl(current) : null;

  return (
    <div className="studio-grid is-two">
      <aside className="studio-rail">
        {groups.map((g) => (
          <div key={g}>
            <h2>{g}</h2>
            <ul className="studio-pages">
              {docs
                .filter((d) => d.group === g)
                .map((d) => (
                  <li key={d.file}>
                    <button
                      type="button"
                      className={current?.file === d.file ? 'is-on' : undefined}
                      onClick={() => setCurrent(d)}
                      title={d.file}
                    >
                      {title(d.name)}
                    </button>
                  </li>
                ))}
            </ul>
            {g === 'Newsletter' ? (
              <form
                className="studio-new-doc"
                onSubmit={(e) => {
                  e.preventDefault();
                  void createPost();
                }}
              >
                <input
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value)}
                  placeholder="new-post-name"
                  aria-label="New post name"
                />
                <button type="submit" disabled={!newSlug.trim()}>
                  + Post
                </button>
              </form>
            ) : null}
          </div>
        ))}
      </aside>

      <main className="studio-stage">
        <div className="studio-urlbar">
          <span className="studio-hero-note" style={{marginLeft: 0}}>
            {current ? current.file : 'No document selected'}
          </span>
          {url ? (
            <a className="studio-hero-note" href={url} target="_blank" rel="noreferrer">
              Open {url}
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
              disabled={!dirty}
            >
              {dirty ? 'Save' : 'Saved'}
            </button>
          </div>
        </div>

        <textarea
          className="studio-doc"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck
        />
      </main>
    </div>
  );
}
