import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const cart = read('../routes/cart.$.tsx');
const shipTo = read('../components/ShipToSelect.tsx');
const css = read('../styles/app.css');

describe('cart steppers', () => {
  it('use aria-disabled, never the disabled attribute, at the min and max', () => {
    assert.match(cart, /aria-disabled=\{disabled \|\| undefined\}/);
    assert.doesNotMatch(cart, /<button type="submit" disabled=\{disabled\}/);
    assert.match(cart, /disabled=\{quantity <= 1\}/);
    assert.match(cart, /disabled=\{quantity >= max\}/);
  });
  it('are not submit buttons while at a limit (no-JS Decrease at 1 cannot post)', () => {
    assert.match(cart, /type=\{disabled \? 'button' : 'submit'\}/);
    assert.match(cart, /quantity=\{Math\.max\(1, quantity - 1\)\}/);
  });
  it('have no hover highlight and a not-allowed cursor when aria-disabled', () => {
    assert.match(css, /stepper button\[aria-disabled='true'\] \{[^}]*cursor: not-allowed/);
    assert.match(css, /button\[aria-disabled='true'\]:hover \{[^}]*background: transparent/);
  });
});

describe('cart announcements', () => {
  it('announces quantity with the line name', () => {
    assert.match(cart, /'Quantity \{count\}, \{name\}'/);
    assert.match(cart, /className="cart-sheet-qty-value" aria-hidden="true"/);
  });
  it('announces a removal and puts the empty cart in a status region', () => {
    assert.match(cart, /'Removed \{name\}'/);
    assert.match(cart, /<div role="status"><EmptyCart \/><\/div>/);
  });
});

describe('focus after Remove', () => {
  it('goes next row, then previous row, then the cart heading', () => {
    assert.match(cart, /row\?\.nextElementSibling \?\? row\?\.previousElementSibling \?\? null/);
    const fn = cart.slice(cart.indexOf('function focusAfterRemove'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.ok(body.indexOf('.cart-line-remove') < body.indexOf('CART_HEADING_ID'));
    assert.match(cart, /id=\{CART_HEADING_ID\} tabIndex=\{-1\}/);
    assert.match(cart, /const CART_HEADING_ID = 'cart-heading'/);
  });
});

describe('ShipToSelect', () => {
  it('never uses the native disabled attribute while busy', () => {
    const select = shipTo.slice(shipTo.indexOf('<select'), shipTo.indexOf('</select>'));
    assert.doesNotMatch(select, /(?<![-\w])disabled=/);
    assert.match(select, /aria-disabled=\{busy \|\| undefined\}/);
  });
  it('restores focus after the switch', () => {
    assert.match(shipTo, /restoreFocus/);
  });
});
