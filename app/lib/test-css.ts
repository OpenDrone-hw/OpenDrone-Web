import {readFileSync, readdirSync} from 'node:fs';

const STYLES = new URL('../styles/', import.meta.url);
const ROUTES = new URL('routes/', STYLES);

/** app.css plus the route-only files split out of it, for tests that assert on a rule wherever it lives. */
export const appCss = () =>
  [
    readFileSync(new URL('app.css', STYLES), 'utf8'),
    ...readdirSync(ROUTES).map((f) => readFileSync(new URL(f, ROUTES), 'utf8')),
  ].join('\n');
