import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {
  LAT_STEP,
  MAX_LAT,
  PILOT_CONSENT_VERSION,
  cellHalfSpan,
  cleanDiscordId,
  cleanDiscordName,
  consentGiven,
  discordProfileUrl,
  groupPins,
  parseCellId,
  qualifiesAsOwner,
  snapToCell,
  viewFor,
  type PinRow,
} from './pilot-map.ts';

const km = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const r = 6371;
  const p = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * p) / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(((lon2 - lon1) * p) / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
};

describe('snapToCell', () => {
  it('is deterministic and the stored point is the cell centre, not the input', () => {
    const a = snapToCell(52.5201, 13.4049);
    const b = snapToCell(52.5201, 13.4049);
    assert.deepEqual(a, b);
    assert.ok(a);
    assert.notEqual(a.lat, 52.5201);
    assert.notEqual(a.lon, 13.4049);
  });

  it('gives every point of a cell the same cell, and neighbours a different one', () => {
    const cell = snapToCell(50.85, 4.35)!;
    assert.deepEqual(snapToCell(cell.lat, cell.lon), cell);
    assert.deepEqual(snapToCell(cell.lat + 0.02, cell.lon + 0.01), cell);
    assert.notEqual(snapToCell(cell.lat + LAT_STEP, cell.lon)!.id, cell.id);
  });

  it('keeps the centre within about 10 km of the input at any latitude', () => {
    for (const [lat, lon] of [[0, 0], [-33.9, 151.2], [52.5, 13.4], [64.1, -21.9], [78.2, 15.6], [-54.8, -68.3], [35.7, 139.7], [40.7, -74]] as const) {
      const cell = snapToCell(lat, lon)!;
      const d = km(lat, lon, cell.lat, cell.lon);
      assert.ok(d < 8, `${lat},${lon} moved ${d.toFixed(1)} km`);
    }
  });

  it('makes cells about 10 km wide in both directions', () => {
    for (const lat of [0, 30, 52, 70, 79]) {
      const a = snapToCell(lat + 0.01, 10)!;
      const east = snapToCell(a.lat, a.lon + 0.0001)!; // same cell
      assert.equal(east.id, a.id);
      let b = a;
      let lon = a.lon;
      while (b.id === a.id) {
        lon += 0.005;
        b = snapToCell(a.lat, lon)!;
      }
      const width = km(a.lat, a.lon, b.lat, b.lon);
      assert.ok(width > 6 && width < 14, `lat ${lat}: ${width.toFixed(1)} km`);
    }
  });

  it('tiles the antimeridian and the south: the last column is reachable, no gap', () => {
    const west = snapToCell(10, -180)!;
    const east = snapToCell(10, 180)!;
    assert.ok(west && east);
    assert.ok(east.lon > 179 && west.lon < -179);
    assert.ok(snapToCell(-MAX_LAT, 0));
    assert.ok(snapToCell(MAX_LAT, 0));
  });

  it('refuses unusable input', () => {
    for (const [lat, lon] of [[NaN, 0], [0, Infinity], [81, 0], [-80.5, 0], [0, 181], [0, -180.5], ['1', 2], [null, 2], [undefined, undefined]] as const) {
      assert.equal(snapToCell(lat, lon), null, `${lat},${lon}`);
    }
  });
});

describe('parseCellId', () => {
  it('round-trips what snapToCell made', () => {
    for (const [lat, lon] of [[52.5, 13.4], [-33.9, 151.2], [0.01, 0.01], [77, -170]] as const) {
      const cell = snapToCell(lat, lon)!;
      assert.deepEqual(parseCellId(cell.id), cell);
    }
  });

  it('rejects malformed or out of grid ids', () => {
    for (const id of ['', 'x', '1', '1:', '1:-2', '99999:1', '10:99999', '10:abc', null, 5, '0:1:2']) assert.equal(parseCellId(id), null, String(id));
  });
});

describe('Discord fields', () => {
  it('accepts snowflakes only', () => {
    assert.equal(cleanDiscordId('80351110224678912'), '80351110224678912');
    for (const bad of ['abc', '123', '1234567890123456x', 80351110224678912, null, '../../x']) assert.equal(cleanDiscordId(bad), null);
  });

  it('cleans names', () => {
    assert.equal(cleanDiscordName('  Mira\u0007 '), 'Mira');
    assert.equal(cleanDiscordName('x'.repeat(100))?.length, 64);
    assert.equal(cleanDiscordName('   '), null);
    assert.equal(cleanDiscordName(5), null);
  });

  it('builds the profile link from the id', () => {
    assert.equal(discordProfileUrl('80351110224678912'), 'https://discord.com/users/80351110224678912');
  });
});

describe('consentGiven', () => {
  const ok = {consent: '1', age16: '1', version: PILOT_CONSENT_VERSION};
  it('needs both boxes and the current version', () => {
    assert.equal(consentGiven(ok), true);
    assert.equal(consentGiven({...ok, consent: undefined}), false);
    assert.equal(consentGiven({...ok, age16: ''}), false);
    assert.equal(consentGiven({...ok, version: 'old'}), false);
    assert.equal(consentGiven({}), false);
  });
});

const row = (cell: string, id: string, name: string): PinRow => {
  const c = parseCellId(cell)!;
  return {cell_id: c.id, cell_lat: c.lat, cell_lon: c.lon, discord_id: id, discord_name: name};
};

describe('groupPins and viewFor', () => {
  const cellA = snapToCell(52.5, 13.4)!.id;
  const cellB = snapToCell(50.8, 4.3)!.id;
  const rows = [
    row(cellA, '111111111111111111', 'zed'),
    row(cellB, '222222222222222222', 'Mira'),
    row(cellA, '333333333333333333', 'amy'),
    {cell_id: 'garbage', cell_lat: 0, cell_lon: 0, discord_id: '444444444444444444', discord_name: 'x'},
  ];

  it('groups by cell, biggest first, names sorted, bad rows dropped', () => {
    const cells = groupPins(rows);
    assert.equal(cells.length, 2);
    assert.equal(cells[0]!.id, cellA);
    assert.deepEqual(cells[0]!.pilots.map((p) => p.name), ['amy', 'zed']);
  });

  it('gives a non-owner the total and nothing else', () => {
    const view = viewFor(false, rows);
    assert.deepEqual(view, {total: 3});
    assert.equal('cells' in view, false);
    assert.doesNotMatch(JSON.stringify(view), /amy|Mira|zed|111111|\d+:\d+/);
  });

  it('gives a qualified owner the cells', () => {
    const view = viewFor(true, rows);
    assert.equal(view.total, 3);
    assert.equal(view.cells?.length, 2);
  });

  it('is empty without pins', () => {
    assert.deepEqual(viewFor(false, []), {total: 0});
    assert.deepEqual(viewFor(true, []), {total: 0, cells: []});
  });
});

describe('qualifiesAsOwner', () => {
  const paid = new Set(['PAID', 'PARTIALLY_REFUNDED']);
  it('needs a paid, not cancelled order', () => {
    assert.equal(qualifiesAsOwner([{cancelledAt: null, displayFinancialStatus: 'PAID'}], paid), true);
    assert.equal(qualifiesAsOwner([{cancelledAt: null, displayFinancialStatus: 'PARTIALLY_REFUNDED'}], paid), true);
    assert.equal(qualifiesAsOwner([{cancelledAt: '2026-01-01', displayFinancialStatus: 'PAID'}], paid), false);
    assert.equal(qualifiesAsOwner([{cancelledAt: null, displayFinancialStatus: 'PENDING'}], paid), false);
    assert.equal(qualifiesAsOwner([{cancelledAt: null, displayFinancialStatus: 'REFUNDED'}], paid), false);
    assert.equal(qualifiesAsOwner([], paid), false);
    assert.equal(qualifiesAsOwner(null, paid), false);
  });
});

describe('cellHalfSpan', () => {
  it('spans about 10 km: 0.09 degrees of latitude, wider in longitude away from the equator', () => {
    const eq = snapToCell(0.01, 0.01)!;
    const north = snapToCell(60, 10)!;
    assert.equal(cellHalfSpan(eq).lat, LAT_STEP / 2);
    assert.ok(Math.abs(cellHalfSpan(eq).lon - LAT_STEP / 2) < 0.002);
    assert.ok(cellHalfSpan(north).lon > cellHalfSpan(eq).lon * 1.8);
  });
});
