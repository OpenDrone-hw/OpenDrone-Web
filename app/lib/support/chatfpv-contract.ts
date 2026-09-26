/**
 * The ChatFPV service contract, vendored from incutec-org/chatfpv
 * `worker/src/contract.ts` at commit
 * 9c1e95e967fc302a7613bf76bf3a446b1faa87e7. Only the shapes the storefront
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
};

export type DraftResponse = {
  draftId: string;
  draft: string | null; // null when the bot should not suggest anything (orders, refunds, no grounding)
  citations: Citation[];
  confidence: number;
  note: string; // one line for staff: why this draft, or why none
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
