// UI strings (owner: shell). t(key, vars) uses the active language, falls back to en, then to the key itself.

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch ' + url + ' ' + r.status);
  return r.json();
}

export async function loadStrings(lang = 'en') {
  const en = await fetchJson('i18n/en.json');
  let active = en;
  if (lang !== 'en') {
    try { active = await fetchJson('i18n/' + lang + '.json'); } catch (err) { active = {}; }
  }
  return function t(key, vars = {}) {
    let s = active[key];
    if (s === null || s === undefined) s = en[key];
    if (s === null || s === undefined) return key;
    return String(s).replace(/\{(\w+)\}/g, (m, name) => (vars[name] === undefined || vars[name] === null ? m : String(vars[name])));
  };
}

export function pick(field, lang) {
  if (!field) return null;
  const v = field[lang];
  if (v !== null && v !== undefined) return v;
  return field.en ?? null;
}
