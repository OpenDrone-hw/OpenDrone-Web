/**
 * The ChatFPV service contract, vendored from incutec-org/chatfpv
 * `worker/src/contract.ts` at commit (branch chatfpv/order-drafts, PR 191; re-pin to the merge commit)
 * ae7ac62c34f4ede013c95a56cb7994ff2e806556. Only the shapes the storefront
 * uses, unchanged. A shape change there is a breaking change here: update
 * this file and the commit above together.
 */

export type Mode = 'fpv' | 'opendrone';
export type Surface = 'web' | 'widget' | 'discord' | 'ticket';

export type Citation = {
  n: number; // [n] marker used in the answer text
  title: string;
  url: string;
  source: string; // source name, 'Betaflight docs'
  kind: 'doc' | 'fact' | 'product' | 'pinout' | 'compat' | 'release' | 'web';
  version?: string;
  fetchedAt?: number;
};

export type Outcome = 'answered' | 'clarify' | 'abstain' | 'handoff' | 'refused';

/** POST /v1/chat. Streams Server-Sent Events when stream is true. */
export type ChatRequest = {
  conversationId?: string; // omitted on the first turn
  message: string;
  mode?: Mode; // 'opendrone' adds OpenDrone product context and store policies
  surface?: Surface;
  stream?: boolean;
  context?: {
    product?: string; // product family or handle of the page the user is on
    orderNumber?: string; // never used for lookup here; only passed as context
    page?: string;
  };
};

export type ChatAnswer = {
  conversationId: string;
  messageId: string;
  answer: string; // Markdown with [n] citation markers
  citations: Citation[];
  outcome: Outcome;
  confidence: number; // 0..1
  handoff?: {reason: string; url: string}; // e.g. open a support ticket
  followups?: string[];
  /** Answer blocks; the storefront reads only the product card kind. */
  blocks?: ProductBlock[];
};

/** A product card for an answer about one OpenDrone product (ChatFPV `ProductBlock`, fields the storefront reads). */
export type ProductBlock = {
  kind: 'product';
  title: string;
  url: string; // https://opendrone.be/products/<handle>
  status: string; // e.g. 'coming soon, not orderable yet, no price' or 'in stock, EUR 49.00'
  variant?: string; // the variant the question or page names
};

/**
 * POST /v1/draft (storefront only, X-ChatFPV-Key). A suggested staff answer
 * for a support ticket. Never shown to a customer until staff approve it.
 */
export type DraftRequest = {
  ticketRef: string;
  topic: 'order' | 'product' | 'warranty' | 'other';
  product?: string;
  firmware?: string;
  conversation: Array<{role: 'customer' | 'staff'; text: string}>;
  /**
   * Additive, optional: the ticket's order, sent only when it is VERIFIED to
   * belong to the customer's email. Never an address, phone, email or payment
   * detail. Absent: the draft is generic.
   */
  order?: DraftOrder;
};

/** The order facts a draft may use (POST /v1/draft `order`). */
export type DraftOrder = {
  name: string; // '#1042'
  createdAt: string; // ISO 8601
  financialStatus?: string;
  fulfillmentStatus?: string;
  holds?: {preorderHold: boolean; reason?: string};
  lineItems: Array<{title: string; quantity: number; preorderBatch?: string; shipBy?: string}>;
  shippingCountry?: string;
  totalPrice?: string;
  currency?: string;
  tracking?: Array<{carrier?: string; url?: string}>;
};

export type DraftResponse = {
  draftId: string;
  draft: string | null; // null when the bot should not suggest anything (orders, refunds, no grounding)
  citations: Citation[];
  confidence: number;
  note: string; // one line for staff: why this draft, or why none
  /** Additive, optional: a team-audience note for the staff thread only, never for the customer. */
  staffNote?: string;
  /** Additive, optional: a team member must act (order change, refund, cancellation, claim). */
  needsHumanAction?: boolean;
  humanActionReason?: string;
};

/**
 * POST /v1/draft/outcome (storefront only). What staff did with a draft.
 * A 'replaced' outcome with a different final text is a correction.
 */
export type DraftOutcomeRequest = {
  draftId: string;
  status: 'approved' | 'replaced' | 'rejected';
  finalText?: string;
  decidedBy: string; // staff Discord user id, a holder of the support role
};
