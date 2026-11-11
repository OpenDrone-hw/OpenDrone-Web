/**
 * EU Declaration of Conformity registry for /doc and /doc/:sku.
 *
 * One entry per hardware SKU. A DoC is published here only when it is
 * signed and banner-free out of the compliance pipeline; until then the
 * page states the real status. To publish: drop the signed PDF in
 * public/doc/ and set {status: 'published', pdf: '/doc/<file>.pdf'}.
 * Radio SKUs additionally never publish before the measured EN 300 328
 * suite exists (RED Art. 17), so their entries stay 'in-preparation'
 * longer than the EMC-only boards.
 */

export type DocStatus = 'in-preparation' | 'published';

export type DocEntry = {
  sku: string;
  name: string;
  status: DocStatus;
  /** Set when status is 'published'. */
  pdf?: string;
  /** Which directives will be / are declared. Shown as factual context. */
  legislation: string[];
};

export const DOC_REGISTRY: DocEntry[] = [
  {
    sku: 'openesc-30x30',
    name: 'OpenESC 30x30 4-in-1 ESC',
    status: 'in-preparation',
    legislation: ['EMC Directive 2014/30/EU', 'RoHS Directive 2011/65/EU'],
  },
  {
    sku: 'openesc-20x20',
    name: 'OpenESC 20x20 4-in-1 ESC',
    status: 'in-preparation',
    legislation: ['EMC Directive 2014/30/EU', 'RoHS Directive 2011/65/EU'],
  },
  {
    sku: 'openfc-lite',
    name: 'OpenFC Lite 30×30 flight controller',
    status: 'in-preparation',
    legislation: ['EMC Directive 2014/30/EU', 'RoHS Directive 2011/65/EU'],
  },
  {
    sku: 'openfc-lite-mini',
    name: 'OpenFC Lite 20×20 flight controller',
    status: 'in-preparation',
    legislation: ['EMC Directive 2014/30/EU', 'RoHS Directive 2011/65/EU'],
  },
  {
    sku: 'openrx-lite',
    name: 'OpenRX Lite ELRS receiver',
    status: 'in-preparation',
    legislation: ['Radio Equipment Directive 2014/53/EU', 'RoHS Directive 2011/65/EU'],
  },
  {
    sku: 'openrx-lite-ufl',
    name: 'OpenRX Lite U.FL ELRS receiver',
    status: 'in-preparation',
    legislation: ['Radio Equipment Directive 2014/53/EU', 'RoHS Directive 2011/65/EU'],
  },
  {
    sku: 'openrx-mono',
    name: 'OpenRX Mono ELRS receiver',
    status: 'in-preparation',
    legislation: ['Radio Equipment Directive 2014/53/EU', 'RoHS Directive 2011/65/EU'],
  },
  {
    sku: 'openrx-gemini',
    name: 'OpenRX Gemini ELRS receiver',
    status: 'in-preparation',
    legislation: ['Radio Equipment Directive 2014/53/EU', 'RoHS Directive 2011/65/EU'],
  },
  {
    sku: 'openframe',
    name: 'OpenFrame carbon frame',
    status: 'in-preparation',
    legislation: [],
  },
];

export function findDocEntry(sku: string): DocEntry | undefined {
  return DOC_REGISTRY.find((e) => e.sku === sku.toLowerCase());
}
