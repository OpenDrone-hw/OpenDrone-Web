/**
 * What the support forms ask for and accept. Shared by the browser (field
 * layout, live checks) and the Worker (validation), so it imports nothing
 * server-side.
 */

export type TicketTopic = 'order' | 'product' | 'warranty' | 'other';

export const TOPICS: TicketTopic[] = ['order', 'product', 'warranty', 'other'];

export const LIMITS = {
  name: 80,
  product: 80,
  firmware: 60,
  message: 4000,
  minMessage: 10,
};

/** Which fields a topic asks for, and which of them are required. The order
 *  number is never required (founder 2026-10-15): staff ask when they need it. */
export const TOPIC_FIELDS: Record<TicketTopic, {order: 'required' | 'optional' | null; product: 'required' | 'optional' | null; firmware: boolean}> = {
  order: {order: 'optional', product: null, firmware: false},
  product: {order: 'optional', product: 'required', firmware: true},
  warranty: {order: 'optional', product: 'required', firmware: false},
  other: {order: 'optional', product: null, firmware: false},
};

/** One newline style, trimmed: a pasted Windows text is not longer than it looks. */
export function normalizeText(s: string): string {
  return s.replace(/\r\n?/g, '\n').trim();
}
