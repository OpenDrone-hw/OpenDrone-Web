/**
 * The opt-in pilot map's rules, as pure functions (README "Owners map").
 *
 * | Rule | Value |
 * |---|---|
 * | Position stored | the centre of a fixed ~10 km grid cell, never the clicked point |
 * | Who sees names and cells | a signed-in owner with a qualifying order, decided on the server |
 * | Everyone else sees | the number of pilots on the map |
 * | Consent | version `PILOT_CONSENT_VERSION`, 16 or older, withdrawn by deleting the row |
 * | Kept | until withdrawal, erasure, or `PILOT_RETENTION_MS` after the consent |
 *
 * Kept free of worker APIs and path aliases so node:test can load it directly.
 */

/** Bump when the consent wording changes; a row stores the version it was given under. */
export const PILOT_CONSENT_VERSION = '2026-10-v1';

/** A pin is deleted this long after its consent unless the owner confirms again. */
export const PILOT_RETENTION_MS = 730 * 24 * 60 * 60 * 1000;

/** Latitude step of one grid row: 0.09 degrees is about 10 km. */
export const LAT_STEP = 0.09;

/** Beyond this latitude no cell is offered: a column there is under 1 km wide in longitude terms. */
export const MAX_LAT = 80;

const EARTH_ROW_COUNT = Math.ceil((2 * MAX_LAT) / LAT_STEP);

export type Cell = {
  /** `<row>:<col>`, row from the equator in LAT_STEP units, col from longitude -180. */
  id: string;
  /** Cell centre, 4 decimals. */
  lat: number;
  lon: number;
};

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Columns in a grid row: the longitude step widens with 1/cos(lat) so cells stay ~10 km wide, and the row tiles the globe exactly. */
function columnsInRow(row: number): number {
  const centreLat = (row + 0.5) * LAT_STEP;
  const stepLon = LAT_STEP / Math.cos((centreLat * Math.PI) / 180);
  return Math.max(1, Math.floor(360 / stepLon));
}

function cellOf(row: number, col: number): Cell {
  const cols = columnsInRow(row);
  return {
    id: `${row}:${col}`,
    lat: round4((row + 0.5) * LAT_STEP),
    lon: round4(-180 + (col + 0.5) * (360 / cols)),
  };
}

/**
 * The grid cell holding a point, or null for a point that is not a usable
 * position. Deterministic: the same point always gives the same cell, so
 * there is nothing to average out by asking twice.
 */
export function snapToCell(lat: unknown, lon: unknown): Cell | null {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > MAX_LAT || lon < -180 || lon > 180) return null;
  const row = Math.floor(lat / LAT_STEP);
  const cols = columnsInRow(row);
  const col = Math.min(cols - 1, Math.floor(((lon + 180) / 360) * cols));
  return cellOf(row, col);
}

/** Half the side of a cell in degrees, so a map can draw the area a stored centre stands for. */
export function cellHalfSpan(cell: Cell): {lat: number; lon: number} {
  const row = Number(cell.id.split(':')[0]);
  return {lat: LAT_STEP / 2, lon: 180 / columnsInRow(row)};
}

/** The cell for a stored id, or null when the id is malformed or outside the grid. */
export function parseCellId(id: unknown): Cell | null {
  const m = typeof id === 'string' ? /^(-?\d{1,4}):(\d{1,5})$/.exec(id) : null;
  if (!m) return null;
  const row = Number(m[1]);
  const col = Number(m[2]);
  if (Math.abs(row) > EARTH_ROW_COUNT || col >= columnsInRow(row)) return null;
  return cellOf(row, col);
}

/** The Discord snowflake of a user, or null. */
export function cleanDiscordId(raw: unknown): string | null {
  return typeof raw === 'string' && /^\d{15,25}$/.test(raw) ? raw : null;
}

/** A display name for the list: control characters and edge space stripped, at most 64 characters, never empty. */
export function cleanDiscordName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = [...raw]
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, 64);
  return name || null;
}

export const discordProfileUrl = (id: string) => `https://discord.com/users/${id}`;

/** The consent a placement must carry: both boxes ticked, on the current wording. */
export function consentGiven(form: {consent?: unknown; age16?: unknown; version?: unknown}): boolean {
  return form.consent === '1' && form.age16 === '1' && form.version === PILOT_CONSENT_VERSION;
}

export type PinRow = {
  cell_id: string;
  cell_lat: number;
  cell_lon: number;
  discord_id: string;
  discord_name: string;
};

export type PilotCell = {
  id: string;
  lat: number;
  lon: number;
  count: number;
  pilots: {discordId: string; name: string}[];
};

/** The view of the pilot map one viewer gets. `cells` exists only for a signed-in owner. */
export type PilotView = {total: number; cells?: PilotCell[]};

/** Group pins into cells, busiest first then by id, pilots by name. Rows with a bad cell id are dropped. */
export function groupPins(rows: readonly PinRow[]): PilotCell[] {
  const cells = new Map<string, PilotCell>();
  for (const row of rows) {
    const cell = parseCellId(row.cell_id);
    const discordId = cleanDiscordId(row.discord_id);
    const name = cleanDiscordName(row.discord_name);
    if (!cell || !discordId || !name) continue;
    const entry = cells.get(cell.id) ?? {id: cell.id, lat: cell.lat, lon: cell.lon, count: 0, pilots: []};
    entry.count += 1;
    entry.pilots.push({discordId, name});
    cells.set(cell.id, entry);
  }
  const list = [...cells.values()];
  for (const c of list) c.pilots.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.discordId.localeCompare(b.discordId));
  return list.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

/**
 * What a viewer may see. The server calls this with its own decision about
 * the viewer, never one the browser sent: names and cells leave only for
 * `qualifiedOwner`.
 */
export function viewFor(qualifiedOwner: boolean, rows: readonly PinRow[]): PilotView {
  const cells = groupPins(rows);
  const total = cells.reduce((n, c) => n + c.count, 0);
  return qualifiedOwner ? {total, cells} : {total};
}

/** Paid or partly refunded and not cancelled: the order that makes someone an owner. */
export function qualifiesAsOwner(
  orders: readonly {cancelledAt: string | null; displayFinancialStatus: string | null}[] | null,
  paid: ReadonlySet<string>,
): boolean {
  return Boolean(orders?.some((o) => !o.cancelledAt && paid.has(o.displayFinancialStatus ?? '')));
}
