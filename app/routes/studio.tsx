/**
 * OpenDrone Studio: the local editing mirror of the site.
 *
 * DEV ONLY. `app/routes.ts` excludes `**\/studio*.tsx` from a production build,
 * and the write endpoint it talks to is an `apply: 'serve'` Vite plugin, so
 * neither half of this exists in the deployed worker.
 *
 * Three columns. Left is what you can edit, centre is the real site in an
 * iframe, right is the thing you have selected. The iframe is same-origin, so
 * the studio can reach into it, find every element tagged with `data-edit`, and
 * turn a click in the preview into an edit of the exact key it came from. That
 * is the whole trick: the preview is not a mock of the site, it IS the site.
 *
 * Saving writes the JSON file. Vite sees the write, invalidates the module that
 * imported it, and the iframe hot-reloads with the new words. There is no
 * publish step and no database: `git diff` is the changelog and `git checkout`
 * is undo.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {MetaFunction} from 'react-router';
import {PREVIEW_CSS, STUDIO_CSS} from '~/studio/studio-css';
import {StudioTokens} from '~/studio/StudioTokens';
import {StudioChapters} from '~/studio/StudioChapters';
import {StudioGoals} from '~/studio/StudioGoals';
import {StudioHero} from '~/studio/StudioHero';
import {StudioMedia} from '~/studio/StudioMedia';
import {StudioDocs} from '~/studio/StudioDocs';
import {StudioData} from '~/studio/StudioData';
import {flattenLeaves, leafLabel, setLeaf} from '~/studio/leaves';
import {PRODUCT_CONTENT} from '~/lib/product-content';

export const meta: MetaFunction = () => [
  {title: 'OpenDrone Studio'},
  // Belt and braces: this route cannot reach production, but if it somehow did,
  // it should not be indexable.
  {name: 'robots', content: 'noindex, nofollow'},
];

type CopyFile = Record<string, unknown>;
type Tab = 'words' | 'chapters' | 'goals' | 'design' | 'media' | 'docs' | 'data' | 'hero';

/** Handles that have editorial content, so a chapter list means something. */
const PRODUCT_HANDLES = Object.keys(PRODUCT_CONTENT).sort();

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

export default function Studio() {
  const [tab, setTab] = useState<Tab>('words');
  const [files, setFiles] = useState<string[]>([]);
  const [page, setPage] = useState<string | null>(null);
  const [data, setData] = useState<CopyFile>({});
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [route, setRoute] = useState('/');
  const frame = useRef<HTMLIFrameElement>(null);
  // Watches the preview DOM for tagged nodes that appear after load; one
  // observer per loaded document, replaced on every iframe load.
  const previewObserver = useRef<MutationObserver | null>(null);

  /**
   * Everything editable, in two groups.
   *
   * `content/copy/*.json` is one file per page. `content/products/*.json` is
   * one file per product, holding the editorial content the product route
   * renders. They live in different directories because they are read by
   * different modules, but from the editor's point of view they are the same
   * thing: a named bag of strings attached to a URL, so they share this tab.
   *
   * `page` is the repo-relative path without the extension, e.g. `copy/home`
   * or `products/openfc-lite`, so the two groups cannot collide on a name.
   */
  useEffect(() => {
    api<{files: string[]}>('/list')
      .then((r) => {
        const editable = r.files
          .filter((f) => f.startsWith('copy/') || f.startsWith('products/'))
          // The fallback record is not a page and has no URL to preview.
          .filter((f) => !f.endsWith('/_fallback.json'))
          .map((f) => f.slice(0, -'.json'.length));
        setFiles(editable);
        // Open on the homepage rather than whatever sorts first. `account`
        // used to win alphabetically, and its preview is a 400 because the
        // page needs a signed-in session, so the studio greeted you with an
        // error page it had no way to explain.
        if (editable.length && !page) {
          setPage(editable.find((f) => f === 'copy/home') ?? editable[0]);
        }
      })
      .catch((e: unknown) => setStatus(`Could not list content: ${(e as Error).message}`));
    // Run once on mount; `page` is seeded here and owned by the user after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read from disk rather than from the bundled module so the studio always
  // shows what is actually saved, even if HMR has not caught up.
  const loadPage = useCallback((name: string) => {
    api<{data: CopyFile}>('/read', {file: `${name}.json`})
      .then((r) => {
        setData(r.data);
        setDirty({});
        const declared = r.data.$route;
        if (typeof declared === 'string') setRoute(declared);
        // A product file carries no `$route`: its URL is derived from the
        // handle, so the preview can still follow the selection.
        else if (name.startsWith('products/')) {
          setRoute(`/products/${name.slice('products/'.length)}`);
        }
      })
      .catch((e: unknown) => setStatus(`Could not read ${name}: ${(e as Error).message}`));
  }, []);

  useEffect(() => {
    if (page) loadPage(page);
  }, [page, loadPage]);

  // The status line is written by whichever tab is open. Without this it kept
  // showing "25 editable strings on this page" while the Chapters tab was up,
  // describing a page that was no longer on screen.
  useEffect(() => {
    setStatus('');
  }, [tab]);

  /**
   * Wire the preview. Runs on every iframe load, including the reloads Vite
   * triggers after a save, so the annotations are re-attached to the new DOM.
   *
   * Same-origin access is what makes this possible. If the iframe ever pointed
   * at a different origin this would throw, so the failure is caught and
   * reported rather than left as a silently dead preview.
   */
  const wirePreview = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    try {
      // The highlight rules have to live INSIDE the preview document. A
      // `<style>` in the studio's own page does not cross the iframe boundary,
      // which is why the outlines were invisible the first time round.
      const styleId = 'studio-preview-css';
      if (!doc.getElementById(styleId)) {
        const s = doc.createElement('style');
        s.id = styleId;
        s.textContent = PREVIEW_CSS;
        doc.head.appendChild(s);
      }
      doc.body.classList.add('studio-preview');
      const wireNode = (el: HTMLElement) => {
        // The class doubles as the "already wired" marker, so re-runs are
        // idempotent and a React re-render (which produces a fresh node
        // without the class) gets wired again.
        if (el.classList.contains('studio-editable')) return;
        el.classList.add('studio-editable');
        el.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const id = el.getAttribute('data-edit');
          if (!id) return;
          // `data-edit` is `<page>.<key>`, where `<page>` is the copy file's
          // basename. `page` here is the repo-relative path (`copy/home`), since
          // products live in a second directory, so the two are matched by
          // suffix rather than compared directly. Getting this wrong silently
          // selected a file that does not exist and blanked the inspector.
          const dot = id.indexOf('.');
          const name = id.slice(0, dot);
          const key = id.slice(dot + 1);
          const target = files.find((f) => f === name || f.endsWith(`/${name}`));
          if (target && target !== page) setPage(target);
          setSelected(key);
        });
      };
      const wireAll = () =>
        doc.querySelectorAll<HTMLElement>('[data-edit]').forEach(wireNode);
      wireAll();
      // Wiring once at load left every later-rendered tag dead: the teardown
      // list re-renders when its components.json arrives, the cart drawer and
      // newsletter form mount on demand, and a tier switch recreates rows.
      // Watch the document and wire tagged nodes as they appear.
      previewObserver.current?.disconnect();
      previewObserver.current = new MutationObserver(wireAll);
      previewObserver.current.observe(doc.body, {childList: true, subtree: true});
      const nodes = doc.querySelectorAll<HTMLElement>('[data-edit]');
      setStatus(
        nodes.length
          ? `${nodes.length} editable ${nodes.length === 1 ? 'string' : 'strings'} on this page`
          : 'No editable strings on this page yet',
      );
    } catch (e) {
      setStatus(`Preview not reachable: ${(e as Error).message}`);
    }
  }, [page, files]);

  // Drop the preview observer with the component.
  useEffect(() => () => previewObserver.current?.disconnect(), []);

  // A preview click can select a key hundreds of rows deep in a product
  // file's list; bring the highlighted row into view or the click looks
  // like it did nothing.
  // `data` is a dependency on purpose: a preview click on another file sets
  // `selected` before that file's keys have loaded, so the scroll must also
  // run when the list itself arrives.
  useEffect(() => {
    if (!selected) return;
    document
      .querySelector('.studio-keys button.is-on')
      ?.scrollIntoView({block: 'nearest'});
  }, [selected, data]);

  /**
   * Every editable string in the file, addressed by path.
   *
   * Page copy is mostly flat, but product content is not: a spec is a pair
   * inside an array, an in-the-box row is an object, variants nest a whole
   * record per option. Walking to the leaves means one editor handles every
   * shape, instead of a bespoke panel per field that goes stale the day
   * someone adds one.
   */
  const leaves = useMemo(() => flattenLeaves(data), [data]);
  const editableKeys = useMemo(() => leaves.map((l) => l.path), [leaves]);
  const leafDepth = useMemo(
    () => Object.fromEntries(leaves.map((l) => [l.path, l.depth])),
    [leaves],
  );

  const valueOf = (key: string): string => {
    if (key in dirty) return dirty[key];
    return leaves.find((l) => l.path === key)?.value ?? '';
  };

  const isDirty = Object.keys(dirty).length > 0;

  const save = async () => {
    if (!page || !isDirty) return;
    setStatus('Saving…');
    // Rebuild the record rather than mutating: an array-valued key stays an
    // array (paragraph runs), a string stays a string. Splitting on a blank
    // line is the inverse of the join above.
    // Write each edited leaf back in place. `setLeaf` can only replace a string
    // that already exists, so a save can never add or remove structure.
    let next = data;
    for (const [path, text] of Object.entries(dirty)) {
      next = setLeaf(next, path, text);
    }
    try {
      await api('/write', {file: `${page}.json`, data: next});
      setData(next);
      setDirty({});
      setStatus('Saved. The preview reloads on its own.');
    } catch (e) {
      setStatus(`Save failed: ${(e as Error).message}`);
    }
  };

  const revert = () => {
    setDirty({});
    setStatus('Reverted to what is on disk.');
  };

  // Cmd-S saves, because everyone tries it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="studio">
      <style dangerouslySetInnerHTML={{__html: STUDIO_CSS}} />

      <header className="studio-bar">
        <span className="studio-brand">
          OpenDrone <b>Studio</b>
        </span>
        <nav className="studio-tabs">
          <button
            type="button"
            className={tab === 'words' ? 'is-on' : undefined}
            onClick={() => setTab('words')}
          >
            Words
          </button>
          <button
            type="button"
            className={tab === 'chapters' ? 'is-on' : undefined}
            onClick={() => setTab('chapters')}
          >
            Chapters
          </button>
          <button
            type="button"
            className={tab === 'goals' ? 'is-on' : undefined}
            onClick={() => setTab('goals')}
          >
            Goals
          </button>
          <button
            type="button"
            className={tab === 'design' ? 'is-on' : undefined}
            onClick={() => setTab('design')}
          >
            Design
          </button>
          <button
            type="button"
            className={tab === 'media' ? 'is-on' : undefined}
            onClick={() => setTab('media')}
          >
            Media
          </button>
          <button
            type="button"
            className={tab === 'docs' ? 'is-on' : undefined}
            onClick={() => setTab('docs')}
          >
            Docs
          </button>
          <button
            type="button"
            className={tab === 'data' ? 'is-on' : undefined}
            onClick={() => setTab('data')}
          >
            Data
          </button>
          <button
            type="button"
            className={tab === 'hero' ? 'is-on' : undefined}
            onClick={() => setTab('hero')}
          >
            Hero
          </button>
        </nav>
        <span className="studio-status">{status}</span>
        {/* Words saves here; every other tab carries its own Save. */}
        <div className="studio-actions" hidden={tab !== 'words'}>
          <button type="button" onClick={revert} disabled={!isDirty}>
            Revert
          </button>
          <button
            type="button"
            className="is-primary"
            onClick={() => void save()}
            disabled={!isDirty}
          >
            {isDirty ? `Save ${Object.keys(dirty).length}` : 'Saved'}
          </button>
        </div>
      </header>

      {tab === 'docs' ? (
        <StudioDocs setStatus={setStatus} />
      ) : tab === 'data' ? (
        <StudioData setStatus={setStatus} />
      ) : tab === 'media' ? (
        <StudioMedia setStatus={setStatus} />
      ) : tab === 'hero' ? (
        <StudioHero setStatus={setStatus} />
      ) : tab === 'design' ? (
        <StudioTokens frame={frame} route={route} setStatus={setStatus} />
      ) : tab === 'chapters' ? (
        <StudioChapters
          frame={frame}
          handles={PRODUCT_HANDLES}
          setStatus={setStatus}
        />
      ) : tab === 'goals' ? (
        <StudioGoals setStatus={setStatus} />
      ) : (
        <div className="studio-grid">
          <aside className="studio-rail">
            <h2>Pages</h2>
            {files.length === 0 ? (
              <p className="studio-empty">
                No copy files yet. They live in <code>content/copy/</code>.
              </p>
            ) : (
              <ul className="studio-pages">
                {files
                  .filter((f) => f.startsWith('copy/'))
                  .map((f) => (
                    <li key={f}>
                      <button
                        type="button"
                        className={f === page ? 'is-on' : undefined}
                        onClick={() => {
                          setPage(f);
                          setSelected(null);
                        }}
                      >
                        {f.slice('copy/'.length)}
                      </button>
                    </li>
                  ))}
              </ul>
            )}

            {files.some((f) => f.startsWith('products/')) ? (
              <>
                <h2>Products</h2>
                <ul className="studio-pages">
                  {files
                    .filter((f) => f.startsWith('products/'))
                    .map((f) => (
                      <li key={f}>
                        <button
                          type="button"
                          className={f === page ? 'is-on' : undefined}
                          onClick={() => {
                            setPage(f);
                            setSelected(null);
                          }}
                        >
                          {f.slice('products/'.length)}
                        </button>
                      </li>
                    ))}
                </ul>
              </>
            ) : null}

            <h2>Strings on this page</h2>
            <ul className="studio-keys">
              {editableKeys.map((k) => (
                <li key={k}>
                  <button
                    type="button"
                    style={{paddingLeft: 8 + Math.max(0, (leafDepth[k] ?? 1) - 1) * 10}}
                    className={[
                      k === selected ? 'is-on' : '',
                      k in dirty ? 'is-dirty' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => setSelected(k)}
                  >
                    <span className="studio-key">{leafLabel(k)}</span>
                    <span className="studio-peek">{valueOf(k).slice(0, 60)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <main className="studio-stage">
            <div className="studio-urlbar">
              <input
                value={route}
                onChange={(e) => setRoute(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && frame.current) {
                    frame.current.src = route;
                  }
                }}
                aria-label="Preview address"
              />
              <button
                type="button"
                onClick={() => {
                  if (frame.current) frame.current.src = route;
                }}
              >
                Go
              </button>
            </div>
            <iframe
              ref={frame}
              title="Site preview"
              src={route}
              onLoad={wirePreview}
            />
          </main>

          <aside className="studio-inspector">
            {selected ? (
              <>
                <h2>{selected}</h2>
                <p className="studio-hint">
                  content/{page}.json · {selected}
                </p>
                <textarea
                  value={valueOf(selected)}
                  onChange={(e) =>
                    setDirty((d) => ({...d, [selected]: e.target.value}))
                  }
                  spellCheck
                />
                {selected in dirty ? (
                  <button
                    type="button"
                    className="studio-undo"
                    onClick={() =>
                      setDirty((d) => {
                        const {[selected]: _drop, ...rest} = d;
                        return rest;
                      })
                    }
                  >
                    Undo this one
                  </button>
                ) : null}
              </>
            ) : (
              <p className="studio-empty">
                Click any highlighted text in the preview, or pick a string on
                the left.
              </p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
