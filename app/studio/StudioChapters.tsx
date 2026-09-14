import {useCallback, useEffect, useMemo, useState} from 'react';
import type {RefObject} from 'react';
import {
  CHAPTER_TYPES,
  DEFAULT_CHAPTERS,
  type ChapterEntry,
  type ChapterConfig,
  type ChapterType,
} from '~/lib/chapters';

/**
 * The Chapters tab: add, remove, reorder and rename the sections of a product
 * page.
 *
 * Order is the argument a product page makes, so this is the most consequential
 * tab in the studio and the one most able to produce a worse page. Two things
 * push back on that. Numbers are shown live, recomputed from position, so the
 * effect of a move is visible before saving. And a chapter can be switched off
 * instead of deleted, so undoing a decision does not mean re-authoring it.
 *
 * Most types are backed by real components and cannot be created from nothing:
 * a second Teardown would have no board to draw. `prose` is the type that can
 * be added freely, which is what "add a chapter" means in practice.
 */

const FILE = 'chapters.json';

/** Human labels. The type name is an implementation detail the editor should not read. */
const LABELS: Record<ChapterType, string> = {
  whatIsThis: 'What does this do?',
  openSource: 'Open for learning',
  teardown: 'Teardown',
  specs: 'Datasheet',
  inTheBox: 'In the box',
  downloads: 'Downloads',
  firmware: 'Firmware',
  contributors: 'Contributors',
  reviews: 'Reviews',
  prose: 'Free text',
};

/**
 * Types that exist once per page at most. Adding a second one would render an
 * empty duplicate, because the data behind them is singular.
 */
const SINGLETON: ChapterType[] = CHAPTER_TYPES.filter((t) => t !== 'prose');

/** Why a chapter might show nothing even when it is switched on. */
const CAVEATS: Partial<Record<ChapterType, string>> = {
  whatIsThis: 'Needs a whatIsThis block in the product file.',
  contributors: 'Fills itself from GitHub. Nothing to write here.',
  reviews: 'Appears only once a product has published ratings in Odoo.',
  teardown: 'Needs board art or a frame viewer for this product.',
  firmware: 'Hidden on bundles and on products not yet for sale.',
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

/** A fresh id that cannot collide with one already in the list. */
function newId(type: ChapterType, list: ChapterEntry[]): string {
  const base = type === 'prose' ? 'text' : type;
  let n = 1;
  let id = base;
  while (list.some((e) => e.id === id)) id = `${base}-${++n}`;
  return id;
}

export function StudioChapters({
  frame,
  handles,
  setStatus,
}: {
  frame: RefObject<HTMLIFrameElement | null>;
  handles: string[];
  setStatus: (s: string) => void;
}) {
  const [config, setConfig] = useState<ChapterConfig>({default: DEFAULT_CHAPTERS});
  const [saved, setSaved] = useState<string>('');
  const [handle, setHandle] = useState<string>(handles[0] ?? '');
  const [drag, setDrag] = useState<number | null>(null);

  useEffect(() => {
    api<{data: ChapterConfig}>('/read', {file: FILE})
      .then((r) => {
        setConfig(r.data);
        setSaved(JSON.stringify(r.data));
      })
      .catch(() => {
        // No chapters.json yet: the shipped order is the starting point.
        const seed = {default: DEFAULT_CHAPTERS};
        setConfig(seed);
        setSaved(JSON.stringify(seed));
      });
  }, []);

  /**
   * The list being edited. A product with no override edits the default, which
   * is what you want most of the time: one change, every product. Choosing
   * "just this product" forks a copy.
   */
  const [scope, setScope] = useState<'default' | 'product'>('default');
  const list = useMemo(() => {
    if (scope === 'product') return config.products?.[handle] ?? config.default;
    return config.default;
  }, [config, scope, handle]);

  const write = useCallback(
    (next: ChapterEntry[]) => {
      setConfig((c) =>
        scope === 'product'
          ? {...c, products: {...(c.products ?? {}), [handle]: next}}
          : {...c, default: next},
      );
    },
    [scope, handle],
  );

  const move = (from: number, to: number) => {
    if (to < 0 || to >= list.length || from === to) return;
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    write(next);
  };

  const toggle = (i: number) =>
    write(list.map((e, j) => (j === i ? {...e, enabled: e.enabled === false} : e)));

  const rename = (i: number, title: string) =>
    write(
      list.map((e, j) =>
        // An empty box means "use the built-in title", not "no title".
        j === i ? {...e, title: title.trim() ? title : undefined} : e,
      ),
    );

  const remove = (i: number) => write(list.filter((_, j) => j !== i));

  const add = (type: ChapterType) =>
    write([...list, {id: newId(type, list), type}]);

  const dirty = JSON.stringify(config) !== saved;

  const save = async () => {
    try {
      await api('/write', {file: FILE, data: config});
      setSaved(JSON.stringify(config));
      setStatus('Chapter order saved. The preview reloads on its own.');
    } catch (e) {
      setStatus(`Save failed: ${(e as Error).message}`);
    }
  };

  const revert = () => {
    setConfig(JSON.parse(saved) as ChapterConfig);
    setStatus('Reverted to what is on disk.');
  };

  const dropProductOverride = () => {
    setConfig((c) => {
      const {[handle]: _drop, ...rest} = c.products ?? {};
      return {...c, products: rest};
    });
    setScope('default');
  };

  const hasOverride = Boolean(config.products?.[handle]);
  // Numbers come from position among the ENABLED entries, exactly as
  // resolveChapters does it, so what you see here is what the page will show.
  let n = 0;

  return (
    <div className="studio-tokens">
      <div className="studio-token-list">
        <p className="studio-token-note">
          Order is the argument the page makes. Numbers update as you move
          things. A chapter that is off keeps its content and can be turned back
          on.
        </p>

        <h2>Product</h2>
        <select
          className="studio-select"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
        >
          {handles.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>

        <h2>Applies to</h2>
        <div className="studio-scope">
          <button
            type="button"
            className={scope === 'default' ? 'is-on' : undefined}
            onClick={() => setScope('default')}
          >
            Every product
          </button>
          <button
            type="button"
            className={scope === 'product' ? 'is-on' : undefined}
            onClick={() => setScope('product')}
          >
            Just {handle}
          </button>
        </div>
        {scope === 'product' && hasOverride ? (
          <button type="button" className="studio-undo" onClick={dropProductOverride}>
            Drop this product&rsquo;s own order
          </button>
        ) : null}
        {scope === 'product' && !hasOverride ? (
          <p className="studio-token-note">
            This product follows the shared order. Changing anything here gives
            it its own copy.
          </p>
        ) : null}

        <h2>Chapters</h2>
        <ol className="studio-chapters">
          {list.map((e, i) => {
            const on = e.enabled !== false;
            if (on) n += 1;
            return (
              <li
                key={e.id}
                className={`studio-chapter${on ? '' : ' is-off'}${
                  drag === i ? ' is-dragging' : ''
                }`}
                draggable
                onDragStart={() => setDrag(i)}
                onDragEnd={() => setDrag(null)}
                onDragOver={(ev) => ev.preventDefault()}
                onDrop={(ev) => {
                  ev.preventDefault();
                  if (drag !== null) move(drag, i);
                  setDrag(null);
                }}
              >
                <span className="studio-chapter-num">
                  {on ? String(n).padStart(2, '0') : '--'}
                </span>
                <div className="studio-chapter-main">
                  <input
                    type="text"
                    value={e.title ?? ''}
                    placeholder={LABELS[e.type]}
                    aria-label={`${LABELS[e.type]} title`}
                    onChange={(ev) => rename(i, ev.target.value)}
                  />
                  <span className="studio-chapter-type">
                    {LABELS[e.type]}
                    {CAVEATS[e.type] ? ` · ${CAVEATS[e.type]}` : ''}
                  </span>
                </div>
                <div className="studio-chapter-btns">
                  <button type="button" title="Move up" onClick={() => move(i, i - 1)}>
                    ↑
                  </button>
                  <button type="button" title="Move down" onClick={() => move(i, i + 1)}>
                    ↓
                  </button>
                  <button
                    type="button"
                    title={on ? 'Hide this chapter' : 'Show this chapter'}
                    onClick={() => toggle(i)}
                  >
                    {on ? '◉' : '○'}
                  </button>
                  <button type="button" title="Remove" onClick={() => remove(i)}>
                    ✕
                  </button>
                </div>
              </li>
            );
          })}
        </ol>

        <h2>Add a chapter</h2>
        <div className="studio-add">
          <button type="button" onClick={() => add('prose')}>
            + Free text
          </button>
          {SINGLETON.filter((t) => !list.some((e) => e.type === t)).map((t) => (
            <button key={t} type="button" onClick={() => add(t)}>
              + {LABELS[t]}
            </button>
          ))}
        </div>

        <div className="studio-actions" style={{marginTop: 16}}>
          <button type="button" onClick={revert} disabled={!dirty}>
            Revert
          </button>
          <button
            type="button"
            className="is-primary"
            onClick={() => void save()}
            disabled={!dirty}
          >
            {dirty ? 'Save order' : 'Saved'}
          </button>
        </div>
      </div>

      <iframe
        title="Product preview"
        src={handle ? `/products/${handle}` : '/'}
        ref={(el) => {
          if (frame) (frame as {current: HTMLIFrameElement | null}).current = el;
        }}
      />
    </div>
  );
}
