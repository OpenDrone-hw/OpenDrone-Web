/**
 * The studio's own styling, kept as a string and injected by the route.
 *
 * Deliberately NOT in `app/styles/app.css`. That stylesheet ships to every
 * visitor, and the studio never reaches production, so putting these rules
 * there would be dead weight in the bundle for everyone. Keeping them here also
 * means the studio's chrome cannot be broken by a token change the studio
 * itself just made, which matters when the thing you are editing is the theme.
 *
 * Fixed values, not `var(--color-*)`, for exactly that reason: the editor has to
 * stay legible while you are dragging the site's colours around.
 */
export const STUDIO_CSS = `
.studio {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: #0b0b0e;
  color: #e8e8ea;
  font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  z-index: 9999;
}

.studio button { font: inherit; cursor: pointer; }
.studio h2 {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: #7d7d86;
  margin: 18px 0 8px;
  font-weight: 600;
}
.studio h2:first-child { margin-top: 0; }

/* ---- top bar ---- */
.studio-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 14px;
  height: 46px;
  flex: 0 0 auto;
  border-bottom: 1px solid #23232a;
  background: #101014;
}
.studio-brand { font-size: 13px; letter-spacing: 0.02em; color: #9a9aa4; }
.studio-brand b { color: #ffb700; font-weight: 600; }

.studio-tabs { display: flex; gap: 2px; }
.studio-tabs button {
  background: none;
  border: 0;
  color: #8b8b95;
  padding: 5px 12px;
  border-radius: 6px;
}
.studio-tabs button:hover { color: #e8e8ea; background: #1a1a20; }
.studio-tabs button.is-on { color: #0b0b0e; background: #ffb700; font-weight: 600; }

.studio-status {
  flex: 1;
  min-width: 0;
  color: #7d7d86;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.studio-actions { display: flex; gap: 8px; }
.studio-actions[hidden] { display: none; }
.studio-actions button {
  background: #1a1a20;
  border: 1px solid #2b2b33;
  color: #d8d8dc;
  padding: 5px 12px;
  border-radius: 6px;
}
.studio-actions button:hover:not(:disabled) { background: #23232a; }
.studio-actions button:disabled { opacity: 0.4; cursor: default; }
.studio-actions .is-primary {
  background: #ffb700;
  border-color: #ffb700;
  color: #0b0b0e;
  font-weight: 600;
}
.studio-actions .is-primary:hover:not(:disabled) { background: #ffc559; }

/* ---- three columns ---- */
.studio-grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr) 320px;
}
/* A document editor has no inspector column. */
.studio-grid.is-two { grid-template-columns: 260px minmax(0, 1fr); }

.studio-rail, .studio-inspector {
  overflow-y: auto;
  padding: 14px;
  background: #0e0e12;
  scrollbar-width: thin;
  scrollbar-color: #2b2b33 transparent;
}
.studio-rail { border-right: 1px solid #1e1e25; }
.studio-inspector { border-left: 1px solid #1e1e25; }

.studio-pages, .studio-keys { list-style: none; margin: 0; padding: 0; }
.studio-pages button, .studio-keys button {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: 0;
  color: #c4c4cc;
  padding: 6px 8px;
  border-radius: 5px;
  line-height: 1.35;
}
.studio-pages button:hover, .studio-keys button:hover { background: #17171d; }
.studio-pages button.is-on, .studio-keys button.is-on {
  background: #1d1d24;
  color: #fff;
  box-shadow: inset 2px 0 0 #ffb700;
}
.studio-keys .studio-key {
  display: block;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  color: #9a9aa4;
}
.studio-keys button.is-on .studio-key { color: #ffb700; }
.studio-keys .studio-peek,
.studio-pages .studio-peek {
  display: block;
  font-size: 11px;
  color: #63636c;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* An unsaved key is marked in the list, not just in the editor, so you can see
   at a glance what is about to be written. */
.studio-keys button.is-dirty .studio-key::after {
  content: " ●";
  color: #ffb700;
}

/* ---- preview ---- */
.studio-stage { display: flex; flex-direction: column; min-width: 0; background: #17171b; }
.studio-urlbar {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid #1e1e25;
  background: #101014;
}
.studio-urlbar input {
  flex: 1;
  background: #0b0b0e;
  border: 1px solid #2b2b33;
  color: #e8e8ea;
  border-radius: 6px;
  padding: 5px 10px;
  font: inherit;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
}
.studio-urlbar input:focus { outline: none; border-color: #ffb700; }
.studio-urlbar button {
  background: #1a1a20;
  border: 1px solid #2b2b33;
  color: #d8d8dc;
  padding: 5px 14px;
  border-radius: 6px;
}
.studio-stage iframe { flex: 1; width: 100%; border: 0; background: #0d0d10; }

/* ---- inspector ---- */
.studio-inspector textarea {
  width: 100%;
  min-height: 220px;
  resize: vertical;
  background: #0b0b0e;
  border: 1px solid #2b2b33;
  border-radius: 8px;
  color: #e8e8ea;
  padding: 10px;
  font: inherit;
  line-height: 1.6;
}
.studio-inspector textarea:focus { outline: none; border-color: #ffb700; }
.studio-inspector h2 {
  font-family: ui-monospace, Menlo, monospace;
  text-transform: none;
  letter-spacing: 0;
  font-size: 12px;
  color: #ffb700;
}
.studio-hint { color: #63636c; font-size: 11px; margin: 0 0 10px; }
.studio-empty { color: #63636c; font-size: 12px; line-height: 1.6; }
.studio-empty code {
  font-family: ui-monospace, Menlo, monospace;
  color: #9a9aa4;
  background: #17171d;
  padding: 1px 4px;
  border-radius: 3px;
}
.studio-undo {
  margin-top: 8px;
  background: none;
  border: 1px solid #2b2b33;
  color: #9a9aa4;
  padding: 4px 10px;
  border-radius: 6px;
}

/* ---- design tab ---- */
.studio-tokens {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 340px minmax(0, 1fr);
}
.studio-token-list {
  overflow-y: auto;
  padding: 14px;
  border-right: 1px solid #1e1e25;
  background: #0e0e12;
  scrollbar-width: thin;
  scrollbar-color: #2b2b33 transparent;
}
.studio-token {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 5px 0;
}
.studio-token label {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  color: #9a9aa4;
  overflow: hidden;
  text-overflow: ellipsis;
}
.studio-token.is-changed label { color: #ffb700; }
.studio-token-controls { display: flex; gap: 5px; align-items: center; }
.studio-token input[type='color'] {
  width: 26px;
  height: 24px;
  padding: 0;
  border: 1px solid #2b2b33;
  border-radius: 5px;
  background: none;
  cursor: pointer;
}
.studio-token input[type='text'] {
  width: 118px;
  background: #0b0b0e;
  border: 1px solid #2b2b33;
  color: #e8e8ea;
  border-radius: 5px;
  padding: 3px 7px;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
}
.studio-token input[type='text']:focus { outline: none; border-color: #ffb700; }
.studio-token-reset {
  background: none;
  border: 0;
  color: #55555e;
  padding: 0 3px;
  font-size: 14px;
  line-height: 1;
}
.studio-token-reset:hover { color: #ffb700; }
.studio-tokens iframe { width: 100%; height: 100%; border: 0; background: #0d0d10; }
.studio-token-note {
  color: #63636c;
  font-size: 11px;
  line-height: 1.6;
  margin: 0 0 14px;
  padding: 9px 10px;
  background: #121218;
  border-left: 2px solid #2b2b33;
  border-radius: 0 5px 5px 0;
}



/* ---- docs and data tabs ---- */
.studio-doc {
  flex: 1;
  width: 100%;
  border: 0;
  border-radius: 0;
  resize: none;
  background: #0b0b0e;
  color: #d8d8dc;
  padding: 18px 22px;
  font-family: ui-monospace, Menlo, Monaco, monospace;
  font-size: 12.5px;
  line-height: 1.75;
  scrollbar-width: thin;
  scrollbar-color: #2b2b33 transparent;
}
.studio-doc:focus { outline: none; }
.studio-new-doc { display: flex; gap: 6px; margin: 6px 8px 14px; }
.studio-new-doc input {
  flex: 1; min-width: 0; background: #0b0b0e; color: #d8d8dc;
  border: 1px solid #2b2b33; border-radius: 5px; padding: 5px 8px;
  font: 12px ui-monospace, Menlo, monospace;
}
.studio-new-doc button {
  background: #1a1a20; color: #d8d8dc; border: 1px solid #2b2b33;
  border-radius: 5px; padding: 5px 10px; font-size: 12px; cursor: pointer;
}
.studio-new-doc button:disabled { opacity: 0.4; cursor: default; }

/* ---- media tab ---- */
.studio-media {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
}
.studio-media-main { display: flex; flex-direction: column; min-width: 0; }
.studio-media-grid {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
  align-content: start;
  scrollbar-width: thin;
  scrollbar-color: #2b2b33 transparent;
}
.studio-media-item {
  background: #14141a;
  border: 1px solid #23232a;
  border-radius: 8px;
  padding: 8px;
  display: grid;
  gap: 5px;
  text-align: left;
  min-width: 0;
}
.studio-media-item:hover { border-color: #3a3a44; }
.studio-media-item.is-on { border-color: #ffb700; background: #1a1a20; }
/* A checker under the thumb, so a transparent PNG is obviously transparent
   rather than looking like it has a dark background baked in. */
.studio-media-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 84px;
  border-radius: 5px;
  background-color: #0b0b0e;
  background-image:
    linear-gradient(45deg, #17171d 25%, transparent 25%),
    linear-gradient(-45deg, #17171d 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #17171d 75%),
    linear-gradient(-45deg, transparent 75%, #17171d 75%);
  background-size: 12px 12px;
  background-position: 0 0, 0 6px, 6px -6px, -6px 0;
  overflow: hidden;
}
.studio-media-thumb img { max-width: 100%; max-height: 100%; object-fit: contain; }
.studio-media-name {
  font-size: 11px;
  color: #c4c4cc;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.studio-media-size { font-size: 10px; color: #55555e; }
.studio-media-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  border-radius: 8px;
  background: #0b0b0e;
  border: 1px solid #23232a;
  margin-bottom: 8px;
}
.studio-media-preview img { max-width: 100%; max-height: 240px; object-fit: contain; }
.studio-usage { list-style: none; margin: 0; padding: 0; }
.studio-usage li {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  color: #9a9aa4;
  padding: 3px 0;
  border-bottom: 1px solid #17171d;
  overflow-wrap: anywhere;
}

/* ---- hero tab ---- */
.studio-hero { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.studio-hero-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid #1e1e25;
  background: #101014;
  flex: 0 0 auto;
}
.studio-hero-bar label { font-size: 11px; color: #7d7d86; }
.studio-hero-bar .studio-select { width: auto; min-width: 150px; }
.studio-hero-bar button {
  background: #1a1a20;
  border: 1px solid #2b2b33;
  color: #d8d8dc;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
}
.studio-hero-bar button:hover { background: #23232a; }
.studio-hero-bar a { color: #ffb700; font-size: 12px; text-decoration: none; }
.studio-hero-bar a:hover { text-decoration: underline; }
.studio-hero-note {
  margin-left: auto;
  font-size: 11px;
  color: #55555e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* The hero tool is a full-screen app with its own 320px side panel, so it takes
   the whole area rather than sharing it with a second preview column. */
.studio-hero iframe { flex: 1; width: 100%; border: 0; background: #0a0c0f; }

/* ---- chapters tab ---- */
.studio-select {
  width: 100%;
  background: #0b0b0e;
  border: 1px solid #2b2b33;
  color: #e8e8ea;
  border-radius: 6px;
  padding: 5px 8px;
  font: inherit;
  font-size: 12px;
}
.studio-scope { display: flex; gap: 4px; }
.studio-scope button {
  flex: 1;
  background: #14141a;
  border: 1px solid #2b2b33;
  color: #9a9aa4;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 11px;
}
.studio-scope button.is-on { background: #ffb700; border-color: #ffb700; color: #0b0b0e; font-weight: 600; }

.studio-chapters { list-style: none; margin: 0; padding: 0; }
.studio-chapter {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 7px 6px;
  border: 1px solid transparent;
  border-radius: 7px;
  cursor: grab;
}
.studio-chapter:hover { background: #14141a; border-color: #23232a; }
/* A dragged row dims rather than disappears, so the list length stays readable
   while you are deciding where to drop it. */
.studio-chapter.is-dragging { opacity: 0.4; border-style: dashed; border-color: #ffb700; }
.studio-chapter.is-off { opacity: 0.45; }
.studio-chapter-num {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  color: #ffb700;
  text-align: right;
}
.studio-chapter.is-off .studio-chapter-num { color: #55555e; }
.studio-chapter-main { min-width: 0; }
.studio-chapter-main input {
  width: 100%;
  background: none;
  border: 0;
  border-bottom: 1px solid transparent;
  color: #e8e8ea;
  font: inherit;
  font-size: 12px;
  padding: 1px 0;
}
.studio-chapter-main input:hover { border-bottom-color: #2b2b33; }
.studio-chapter-main input:focus { outline: none; border-bottom-color: #ffb700; }
.studio-chapter-main input::placeholder { color: #7d7d86; }
.studio-chapter-type {
  display: block;
  font-size: 10px;
  color: #55555e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.studio-chapter-btns { display: flex; gap: 1px; }
.studio-chapter-btns button {
  background: none;
  border: 0;
  color: #55555e;
  padding: 2px 4px;
  font-size: 11px;
  line-height: 1;
  border-radius: 4px;
}
.studio-chapter-btns button:hover { color: #ffb700; background: #1d1d24; }

.studio-add { display: flex; flex-wrap: wrap; gap: 5px; }
.studio-add button {
  background: #14141a;
  border: 1px dashed #2b2b33;
  color: #9a9aa4;
  padding: 4px 9px;
  border-radius: 6px;
  font-size: 11px;
}
.studio-add button:hover { color: #ffb700; border-color: #ffb700; border-style: solid; }

/* Goals tab: labelled form fields in the inspector. */
.studio-goal-field {
  display: grid;
  gap: 4px;
  margin: 0 0 12px;
  color: #9a9aa4;
  font-size: 11px;
}
.studio-goal-field input,
.studio-goal-field select,
.studio-goal-field textarea {
  width: 100%;
  background: #101014;
  border: 1px solid #26262e;
  border-radius: 6px;
  color: #e6e6ea;
  font: inherit;
  font-size: 12px;
  padding: 6px 8px;
}
.studio-goal-field textarea { min-height: 110px; resize: vertical; }
.studio-goal-field input:focus,
.studio-goal-field select:focus,
.studio-goal-field textarea:focus { outline: none; border-color: #ffb700; }
.studio-goal-field input[type='range'] { padding: 0; accent-color: #ffb700; }

`;

/**
 * Rules injected INTO the preview iframe, not into the studio's own page.
 *
 * A `<style>` in the parent document does not apply inside an iframe, even a
 * same-origin one: each document has its own stylesheet set. These are appended
 * to the preview's `<head>` on every load, which is also what makes the
 * highlights survive the hot reload after a save.
 */
export const PREVIEW_CSS = `
.studio-preview [data-edit] { cursor: text; }
.studio-preview .studio-editable {
  outline: 1px dashed rgba(255, 183, 0, 0.35);
  outline-offset: 2px;
  transition: outline-color 0.12s, background-color 0.12s;
}
.studio-preview .studio-editable:hover {
  outline: 1px solid #ffb700;
  background-color: rgba(255, 183, 0, 0.09);
}
`;
