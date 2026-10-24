import {useCallback, useEffect, useMemo, useState} from 'react';
import type {RefObject} from 'react';
import catalogue from './token-catalogue.json';

/**
 * The Design tab: the site's 61 design tokens, with a live preview.
 *
 * Overrides are written to `content/theme.json` and applied by `root.tsx` as a
 * `:root{}` block. The stylesheet is never rewritten, so nothing here can
 * corrupt app.css, and deleting theme.json restores the designed defaults
 * exactly.
 *
 * Honest limits, surfaced in the UI rather than buried here:
 *
 * - Colour reaches almost everything: the stylesheet uses `var(--…)` 2312
 *   times. There are still 96 hardcoded colour literals it cannot touch.
 * - Spacing does NOT reach much. 868 padding/margin/gap declarations use
 *   hardcoded lengths against only 99 that route through `--sp-*`, so moving a
 *   spacing token changes roughly a tenth of the site's spacing. Fixing that is
 *   a tokenisation pass on app.css, not a studio feature.
 * - Derived tokens are read-only. `--color-accent` is `var(--color-gold)`;
 *   editing it would break the link rather than change the colour.
 */
type Token = {
  name: string;
  value: string;
  group: string;
  derivedFrom: string[];
};

const TOKENS = (catalogue as {tokens: Token[]}).tokens;

/** Group display order and labels. Colour first: it is what actually works. */
const GROUPS: Array<{key: string; label: string; note?: string}> = [
  {key: 'colour', label: 'Colours'},
  {key: 'size', label: 'Text sizes'},
  {key: 'font', label: 'Typefaces'},
  {
    key: 'spacing',
    label: 'Spacing',
    note: 'About a tenth of the site’s spacing runs through these. The rest is hardcoded in the stylesheet and needs a cleanup pass before these sliders reach it.',
  },
  {key: 'radius', label: 'Corner rounding'},
  {key: 'layout', label: 'Layout sizes'},
  {key: 'shadow', label: 'Shadows'},
  {key: 'derived', label: 'Calculated from others', note: 'Read-only. Change the token each one points at.'},
  {key: 'other', label: 'Other'},
];

const THEME_FILE = 'theme.json';

/** Only a plain 6-digit hex can drive a colour input. rgba() and var() cannot. */
const isHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v.trim());

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

export function StudioTokens({
  frame,
  route,
  setStatus,
}: {
  frame: RefObject<HTMLIFrameElement | null>;
  route: string;
  setStatus: (s: string) => void;
}) {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});

  // Load what is already committed, so the panel opens showing the real state
  // of the site rather than the stylesheet defaults.
  useEffect(() => {
    api<{data: Record<string, string>}>('/read', {file: THEME_FILE})
      .then((r) => {
        setOverrides(r.data ?? {});
        setSaved(r.data ?? {});
      })
      .catch(() => {
        // No theme.json yet is the normal starting state, not an error.
        setOverrides({});
        setSaved({});
      });
  }, []);

  /**
   * Push the current overrides into the preview without saving.
   *
   * A single `<style>` element owned by the studio, replaced wholesale on every
   * change. Appended last and scoped to `:root`, so it wins on order against
   * `@theme` at the same specificity.
   */
  const paint = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    const id = 'studio-token-overrides';
    let el = doc.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = doc.createElement('style');
      el.id = id;
      doc.head.appendChild(el);
    }
    const body = Object.entries(overrides)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join('\n');
    el.textContent = body
      ? `:root {\n${body}\n}`
      : '';
  }, [overrides, frame]);

  useEffect(() => {
    paint();
  }, [paint]);

  const set = (name: string, value: string) =>
    setOverrides((o) => ({...o, [name]: value}));

  const reset = (name: string) =>
    setOverrides((o) => {
      const {[name]: _drop, ...rest} = o;
      return rest;
    });

  const dirty = useMemo(
    () => JSON.stringify(overrides) !== JSON.stringify(saved),
    [overrides, saved],
  );

  const save = async () => {
    try {
      await api('/write', {file: THEME_FILE, data: overrides});
      setSaved(overrides);
      setStatus(
        Object.keys(overrides).length
          ? `Saved ${Object.keys(overrides).length} token overrides to content/theme.json`
          : 'Cleared all token overrides',
      );
    } catch (e) {
      setStatus(`Save failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="studio-tokens">
      <div className="studio-token-list">
        <p className="studio-token-note">
          Changes preview instantly. Save writes <code>content/theme.json</code>,
          which the site reads on top of the stylesheet. Deleting that file puts
          everything back.
        </p>

        <div className="studio-actions" style={{marginBottom: 14}}>
          <button type="button" onClick={() => setOverrides({})} disabled={!Object.keys(overrides).length}>
            Reset all
          </button>
          <button type="button" className="is-primary" onClick={() => void save()} disabled={!dirty}>
            {dirty ? 'Save theme' : 'Saved'}
          </button>
        </div>

        {GROUPS.map((g) => {
          const items = TOKENS.filter((t) => t.group === g.key);
          if (!items.length) return null;
          return (
            <section key={g.key}>
              <h2>{g.label}</h2>
              {g.note ? <p className="studio-token-note">{g.note}</p> : null}
              {items.map((t) => {
                const current = overrides[t.name] ?? t.value;
                const changed = t.name in overrides;
                const readOnly = t.group === 'derived';
                return (
                  <div
                    key={t.name}
                    className={`studio-token${changed ? ' is-changed' : ''}`}
                  >
                    <label htmlFor={`tok-${t.name}`} title={`${t.name}: ${t.value}`}>
                      {t.name.replace(/^--/, '')}
                    </label>
                    <div className="studio-token-controls">
                      {isHex(current) && !readOnly ? (
                        <input
                          type="color"
                          aria-label={`${t.name} colour`}
                          value={current}
                          onChange={(e) => set(t.name, e.target.value)}
                        />
                      ) : null}
                      <input
                        id={`tok-${t.name}`}
                        type="text"
                        value={current}
                        readOnly={readOnly}
                        onChange={(e) => set(t.name, e.target.value)}
                      />
                      <button
                        type="button"
                        className="studio-token-reset"
                        title="Back to the designed default"
                        onClick={() => reset(t.name)}
                        disabled={!changed}
                      >
                        ↺
                      </button>
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>

      <iframe
        title="Theme preview"
        src={route}
        onLoad={paint}
        ref={(el) => {
          // Share the ref with the parent so `paint` can reach this document.
          if (frame) (frame as {current: HTMLIFrameElement | null}).current = el;
        }}
      />
    </div>
  );
}
