export type Day = 0 | 1;
export type ReservationState = 'planned' | 'held' | 'confirmed' | 'failed' | 'released' | 'cancelled' | 'replaced';
export type PaymentState = 'none' | 'order_created' | 'authorized' | 'capturing' | 'captured' | 'declined' | 'voiding' | 'voided' | 'expired' | 'unknown';
export type TravelMode = 'walk' | 'metro' | 'taxi' | 'car' | 'none';
export type Kind = 'lodging' | 'transfer' | 'activity' | 'meal';
export const SUPPLIER = 'Simulated supplier' as const;
export interface Place { id: string; name: string; lat: number; lon: number; area: string }
export interface Offer {
  id: string; kind: Kind; name: string; placeId: string; priceCents: number; minutes: number;
  opens: string; closes: string; days: Day[]; tags: string[]; supplier: typeof SUPPLIER; available: boolean;
}
export interface Slot { id: string; day: Day; kind: Kind; targetStart: string; optional?: boolean }
export interface Item {
  id: string; offerId: string; slot: string; kind: Kind; name: string; placeId: string; day: Day;
  start: string; end: string; bufferMin: number; travelMode: TravelMode; priceCents: number; booked: boolean;
  state: ReservationState; supplierRef?: string; why?: string; supplier?: typeof SUPPLIER;
}
export interface Itinerary { version: number; hotelId: string; totalCents: number; items: Item[] }
export type IssueCode = 'BUFFER' | 'OVERLAP' | 'OPEN_HOURS' | 'DAY_WINDOW' | 'CHECKIN' | 'PRICE_MATCH' | 'CEILING' | 'DAYS' | 'DUPLICATE' | 'STATE' | 'AVAILABILITY';
export interface Issue { code: IssueCode; itemId?: string; message: string }
export interface Checks { ok: boolean; issues: Issue[] }
export interface Move { itemId: string; name: string; fromStart: string; toStart: string; fromEnd: string; toEnd: string; reason: string }
export interface Reprice { itemId: string; name: string; fromCents: number; toCents: number }
export interface Candidate {
  id: string; hotelId: string; name: string; area: string; priceDeltaCents: number; newTotalCents: number;
  moves: Move[]; repriced: Reprice[]; dropped: string[]; checks: Checks;
  /** Checked preview, including buffer and price changes which do not move a start time. */
  itinerary: Itinerary;
}
export interface Quote { version: number; totalCents: number; approvedAt: string }
export interface Refund { id?: string; amountCents: number; state: 'pending' | 'completed' | 'failed' | 'unknown'; reason: string }
export interface PaymentReceipt {
  op: string; method: string; path: string; status: number; paypalStatus?: string; debugId?: string; requestId?: string; at: string;
}
export interface PaymentAttempt {
  quoteVersion: number; amountCents: number; method: 'card' | 'paypal'; state: PaymentState; declineTest?: boolean;
  orderId?: string; authorizationId?: string; captureId?: string; expiresAt?: string;
  refunds: Refund[]; receipts: PaymentReceipt[];
  /** Reconciliation diagnostics, never represented as a successful write receipt. */
  log?: string[];
  /** Last known state is retained while a write is uncertain. */
  previousState?: Exclude<PaymentState, 'unknown'>;
}
export interface WebhookReceipt {
  eventId: string; eventType: string; createTime?: string; receivedAt: string;
  signatureVerified: true; quoteVersion: number; resourceId?: string;
  outcome: 'applied' | 'already known' | 'ignored (older than the current state)';
}
export type PickSource = 'live' | 'cached' | 'recorded' | 'rule';
export interface AgentStep {
  tool: 'read_note' | 'read_trip_request' | 'find_options' | 'rank_options' | 'validate_schedule' | 'propose_itinerary' | 'reserve_demo_inventory' | 'repair_failed_leg' | 'replan_slot' | 'paypal' | 'ask_agent';
  at: string; summary: string; source?: PickSource; neurons?: number; aiWords?: boolean;
}
/** The newest "Ask the agent" answer. Every word is built by code from checked facts. */
export interface AskAnswer { text: string; changed: boolean; message: string; reapprove: boolean; quoteNote?: string }
export type Phase = 'planned' | 'quoted' | 'authorized' | 'holding' | 'repair_proposed' | 'requote' | 'confirmed_captured' | 'refund_pending' | 'refunded' | 'declined' | 'checking_payment';
export interface TripView {
  id: string; phase: Phase; ceilingCents: number; tastes: string[]; note: string; itinerary: Itinerary;
  previous?: Pick<Itinerary, 'version' | 'items'>;
  repair?: { failedItemId: string; candidates: Candidate[]; pickId: string; pickReason: string; pickSource: PickSource };
  quote?: Quote; payments: PaymentAttempt[]; webhooks: WebhookReceipt[]; log: AgentStep[]; issues: Issue[]; next: string[];
  /** Absent in recorded snapshots, which show no ask input. */
  asksLeft?: number; lastAsk?: AskAnswer;
}
