import { TASTES, cleanPreferences, rulePreferences, noteSummary } from '../domain/preferences';
export { TASTES } from '../domain/preferences';
import { MAX_AI_CALLS_PER_TRIP, MAX_ASKS_PER_TRIP, MAX_ASK_CHARS, MAX_CEILING_CENTS, MAX_NOTE_CHARS, MAX_PAYPAL_WRITES_PER_TRIP, MIN_CEILING_CENTS } from '../caps';
import { applyAsk, checkChange, namedSlot, ruleAsk, type AskChange } from '../domain/ask';
import { applyPayPalRead, blockedByUnknown, canCapture, canRefund, canVoid, toCents } from '../domain/money';
import { askOptions, buildItinerary, candidatesForSlots, DEFAULT_TASTES, hotelCandidates, type PlanInput } from '../domain/planner';
import { aiChoices, applyCandidate, rankCandidates, repairFailedLeg, replanSlot } from '../domain/repair';
import { transition } from '../domain/reservations';
import type { AgentStep, Item, PaymentAttempt, PickSource, RepairPolicy, TripView, WebhookReceipt } from '../domain/types';
import { isActive, validateSchedule } from '../domain/validate';
import { tasteText, type TripAI, type Proposal, type RepairPick } from '../ai/agent';
import { ApiError } from '../errors';
import { proposalKey, type Gate } from '../gate/engine';
import { PayPal, type PayPalResult } from '../paypal/client';
import { authorizeOrder, captureAuthorization, createOrder, readAuthorization, readCapture, readOrder, readRefund, refundCapture, voidAuthorization, type WriteSpec } from '../paypal/payments';
import type { PayPalEvent } from '../paypal/webhooks';
import { latestAttempt, type Operation, type TripRecord, type TripStore } from './store';

export interface Supplier {
  hold(item: Item): Item | Promise<Item>; confirm(item: Item): Item | Promise<Item>;
  release(item: Item): Item | Promise<Item>; cancel(item: Item): Item | Promise<Item>;
}
export interface TripDependencies {
  store: TripStore; paypal: PayPal; ai: TripAI; gate: Gate; supplier: Supplier; clock: () => Date;
  recorded: {
    propose: { placeholder: boolean; capturedAt: string | null; answer: Proposal };
    repair: { placeholder: boolean; capturedAt: string | null; answer: RepairPick };
  };
}
export function repairReason(candidate: Pick<import('../domain/types').Candidate, 'moves' | 'priceDeltaCents'> & { droppedActivities?: string[] }, oldHotelName?: string) {
  const difference = candidate.priceDeltaCents;
  const money = `$${(Math.abs(difference) / 100).toFixed(2)}`;
  const priceText = oldHotelName && difference < 0 ? `Saves ${money} against ${oldHotelName}. `
    : oldHotelName && difference > 0 ? `Costs ${money} more than ${oldHotelName}. ` : '';
  const count = candidate.moves.length;
  const dropped = candidate.droppedActivities ?? [];
  const activities = dropped.length ? `Drops ${dropped.join(' and ')}. ` : 'Keeps every activity. ';
  return `${priceText}${activities}${count} stop${count === 1 ? '' : 's'} ${count === 1 ? 'moves' : 'move'}; travel buffers kept (estimated times).`;
}
export function tripInput(body: Record<string, unknown>): PlanInput {
  if (!Array.isArray(body.tastes) || !body.tastes.length || body.tastes.length > 10 || body.tastes.some(t => typeof t !== 'string' || !TASTES.includes(t)) ||
    typeof body.note !== 'string' || body.note.length > MAX_NOTE_CHARS || !Number.isInteger(body.ceilingCents) ||
    (body.ceilingCents as number) < MIN_CEILING_CENTS || (body.ceilingCents as number) > MAX_CEILING_CENTS ||
    (body.repairPolicy !== undefined && body.repairPolicy !== 'lowest_total' && body.repairPolicy !== 'keep_activities')) throw new ApiError('BAD_REQUEST', 'Choose valid tastes, a note up to 280 characters, a ceiling from $300 to $1,500, and a repair choice.', 400);
  return { tastes: [...new Set(body.tastes)] as string[], note: body.note, ceilingCents: body.ceilingCents as number,
    repairPolicy: (body.repairPolicy ?? 'lowest_total') as RepairPolicy };
}
const policyOf = (trip: { repairPolicy?: RepairPolicy }): RepairPolicy => trip.repairPolicy ?? 'lowest_total';
const defaults = (input: PlanInput) => policyOf(input) === 'lowest_total' && input.note === '' && input.tastes.length === DEFAULT_TASTES.length && DEFAULT_TASTES.every(t => input.tastes.includes(t));
const requireState: (condition: unknown, message?: string) => asserts condition = (condition, message = 'This action is not available now.') => {
  if (!condition) throw new ApiError('STATE', message);
};
const readKind = (op: Operation['op']) => op === 'create' || op === 'authorize' ? 'order' : op === 'void' ? 'authorization' : op;

/** All business logic is platform independent. The DO queues every entry point, including reads/events. */
export class TripEngine {
  private trip!: TripRecord;
  constructor(private deps: TripDependencies) {}
  private get store() { return this.deps.store; }
  private now() { return this.deps.clock().toISOString(); }
  private step(tool: AgentStep['tool'], summary: string, source: PickSource = 'rule', neurons?: number) {
    this.trip.log.push({ tool, summary, source, at: this.now(), ...(neurons === undefined ? {} : { neurons }) });
  }
  private async load(sid?: string) {
    const record = await this.store.get<TripRecord>('trip');
    if (!record) throw new ApiError('NOT_FOUND', 'Trip not found.', 404);
    if (sid !== undefined && record.sid !== sid) throw new ApiError('NOT_YOUR_TRIP', 'This trip belongs to another browser.', 403);
    this.trip = record;
  }
  private async save() {
    this.refresh();
    await this.store.put('trip', this.trip);
  }
  private refresh() {
    const t = this.trip, a = latestAttempt(t);
    if (blockedByUnknown(t.payments)) { t.phase = 'checking_payment'; t.next = ['reconcile']; return; }
    if (a?.state === 'captured' && a.refunds.length) {
      t.phase = a.refunds.every(r => r.state === 'completed') ? 'refunded' : 'refund_pending';
      t.next = t.phase === 'refunded' ? [] : ['reconcile']; return;
    }
    if (a?.state === 'captured') { t.phase = 'confirmed_captured'; t.next = a.captureId ? ['cancel-activity'] : ['reconcile']; return; }
    if (a?.state === 'capturing') { t.phase = 'checking_payment'; t.next = ['reconcile']; return; }
    if (t.pendingCandidateId || t.pendingAsk) { t.phase = 'checking_payment'; t.next = ['reconcile']; return; }
    if (t.compensation.length) { t.phase = t.repair ? 'repair_proposed' : 'declined'; t.next = ['reconcile']; return; }
    if (t.repair && !t.pendingCandidateId) { t.phase = 'repair_proposed'; t.next = t.repair.candidates.some(c => c.checks.ok) ? ['repair/accept'] : []; return; }
    if (a && ['declined', 'expired'].includes(a.state)) { t.phase = 'declined'; t.next = t.compensation.length ? ['reconcile'] : ['pay']; return; }
    if (a?.state === 'authorized') { t.phase = 'holding'; t.next = ['confirm', 'hotel-unavailable']; return; }
    if (a?.state === 'order_created') { t.phase = 'quoted'; t.next = [a.method === 'card' ? 'pay' : 'authorize']; return; }
    // A requote needs an earlier payment to have been voided; a quote changed by an ask is a plain new quote.
    t.phase = t.quote ? t.itinerary.version > 1 && t.payments.length ? 'requote' : 'quoted' : 'planned';
    t.next = t.issues.length ? [] : t.quote ? ['pay'] : ['quote'];
  }
  private view(): TripView {
    const { sid: _sid, writes: _writes, aiCalls: _aiCalls, asks, repairAsked: _asked, pendingCandidateId: _pending,
      compensation: _compensation, fault: _fault, proposalAnswer: _proposal, repairAnswer: _repair, repairBase: _base, pendingAsk: _ask, ...view } = this.trip;
    return structuredClone({ ...view, webhooks: view.webhooks ?? [], asksLeft: Math.max(0, MAX_ASKS_PER_TRIP - (asks ?? 0)) });
  }
  async create(id: string, sid: string, input: PlanInput): Promise<TripView> {
    const recordedProposal = this.deps.recorded.propose;
    if (await this.store.get('trip')) throw new ApiError('STATE', 'This trip already exists.');
    await this.deps.gate.takeTrip(sid);
    // Cache BEFORE live inference: a cache hit must cost no neurons.
    const key = await proposalKey(input.tastes, input.note), slots = candidatesForSlots(input.tastes), hotels = hotelCandidates(input.tastes);
    let proposal: Proposal | undefined, source: PickSource = 'rule', neurons: number | undefined, label = 'Rule pick from checked offers.', aiCalls = 0;
    let cached = null;
    try { cached = await this.deps.gate.cached(key); } catch { /* A cache failure does not authorize an unmetered call. */ }
    if (cached) { proposal = cached.answer; source = 'cached'; label = `Cached live answer from ${cached.capturedAt.slice(11, 16)} UTC.`; }
    else {
      aiCalls++;
      const live = await this.deps.ai.proposeItinerary(input, slots, hotels);
      if (live?.answer) {
        proposal = live.answer; source = 'live'; neurons = live.neurons; label = 'Live AI pick from checked offers.';
        try { await this.deps.gate.cache(key, { answer: proposal, capturedAt: this.now() }); } catch { /* Live answer is still usable. */ }
      } else if (live) {
        neurons = live.neurons; label = 'AI answer unusable; rule pick';
      } else if (!live && defaults(input) && !recordedProposal.placeholder && recordedProposal.capturedAt) {
        proposal = recordedProposal.answer; source = 'recorded'; label = `Recorded answer from ${recordedProposal.capturedAt}.`;
      }
    }
    let prefs = input.note.trim() ? proposal && source !== 'rule' ? cleanPreferences(proposal.prefs) : rulePreferences(input.note) : {};
    let noteSource = source;
    let plan = buildItinerary(input, proposal?.picks, prefs);
    if (proposal && plan.issues.length) { prefs = rulePreferences(input.note); plan = buildItinerary(input, {}, prefs); source = 'rule'; noteSource = 'rule'; label = 'Rule pick: the proposed plan failed schedule checks.'; }
    if (proposal && source !== 'rule') for (const item of plan.itinerary.items) if (proposal.picks.slots?.[item.slot] === item.offerId) item.why = tasteText(proposal.why[item.slot]);
    const at = this.now();
    this.trip = { id, sid, ...input, itinerary: plan.itinerary, phase: 'planned', payments: [], webhooks: [],
      issues: plan.issues, log: [], next: [], writes: 0, aiCalls, compensation: [], ...(['live', 'cached'].includes(source) ? { proposalAnswer: proposal } : {}) };
    this.trip.log = plan.log.map(l => ({ ...l, at }));
    const validation = this.trip.log.pop()!;
    this.step('read_note', noteSummary(prefs, plan.prefsRejected), noteSource);
    this.step('propose_itinerary', label, source, neurons); this.trip.log.push(validation);
    await this.save(); return this.view();
  }
  async get(sid: string): Promise<TripView> { await this.load(sid); this.refresh(); return this.view(); }
  async action(sid: string, action: string, body: Record<string, unknown> = {}): Promise<TripView | {orderId: string} | {ok: boolean}> {
    await this.load(sid);
    if (action === 'dev/fault') {
      if (body.kind !== 'lose_next_response' && body.kind !== 'expire_authorization') throw new ApiError('BAD_REQUEST', 'Unknown fault kind.', 400);
      this.trip.fault = body.kind; await this.save(); return { ok: true };
    }
    if (action !== 'reconcile' && blockedByUnknown(this.trip.payments)) throw new ApiError('CHECKING_PAYMENT', 'Check the existing payment before any new write.');
    switch (action) {
      case 'quote': this.quote(); break;
      case 'pay/card': await this.pay(true, body.declineTest === true); break;
      case 'pay/order': {
        await this.pay(false);
        await this.save();
        const id = latestAttempt(this.trip)?.orderId;
        if (!id) return this.view();
        return { orderId: id };
      }
      case 'pay/authorize': await this.authorize(body.orderId); break;
      case 'reserve': await this.reserve(); break;
      case 'supplier/hotel-unavailable': await this.hotelFailure(); break;
      case 'repair/accept': await this.accept(body.candidateId); break;
      case 'ask': await this.ask(body.text); break;
      case 'confirm': await this.confirm(); break;
      case 'supplier/cancel-activity': await this.cancelActivity(); break;
      case 'reconcile': await this.reconcile(); break;
      default: throw new ApiError('NOT_FOUND', 'Route not found.', 404);
    }
    await this.save(); return this.view();
  }
  /** One checked change before capture. Held trips use the repair acceptance money path. */
  private async ask(raw: unknown) {
    const t = this.trip;
    this.refresh();
    const holding = t.phase === 'holding' && latestAttempt(t)?.state === 'authorized';
    requireState(holding || (!t.payments.length && ['planned', 'quoted'].includes(t.phase)), 'You can ask for a change before a hold or while the money is held, before capture.');
    requireState((t.asks ?? 0) < MAX_ASKS_PER_TRIP, 'You used both changes for this trip.');
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text || text.length > MAX_ASK_CHARS) throw new ApiError('BAD_REQUEST', `Write a request of 1 to ${MAX_ASK_CHARS} characters.`, 400);
    t.asks = (t.asks ?? 0) + 1;
    const options = askOptions(t.itinerary, t.tastes);
    const ruleChange = ruleAsk(text, t.itinerary, options);
    const requestedSlot = namedSlot(text, t.itinerary, options);
    let change: AskChange | null = null, source: PickSource = 'rule', neurons: number | undefined;
    if (this.deps.ai.askChange && t.aiCalls < MAX_AI_CALLS_PER_TRIP) {
      t.aiCalls++; await this.save(); // The reservation is counted before the call, like every other AI call.
      const live = await this.deps.ai.askChange(text, options, t.itinerary);
      if (live) {
        neurons = live.neurons;
        change = checkChange(live.answer, options);
        if (change && ruleChange !== null && change.slot !== ruleChange.slot) change = null;
        if (change && requestedSlot !== null && change.slot !== requestedSlot) change = null;
        if (change) source = 'live';
      }
    }
    change ??= ruleChange;
    let message = 'I could not turn that into a change. Try one of the examples.', changed = false, reapprove = false, quoteNote: string | undefined;
    if (change) {
      const result = applyAsk(t.itinerary, change, t.ceilingCents, options);
      if (result.ok) {
        changed = true; reapprove = !!t.quote;
        const left = result.dropped.length ? ` ${result.dropped.join(' and ')} no longer ${result.dropped.length > 1 ? 'fit and were' : 'fits and was'} left out.` : '';
        message = `The agent changed ${result.slotLabel}: ${result.from} to ${result.to}.${left}`;
        t.previous = { version: t.itinerary.version, items: structuredClone(t.itinerary.items) };
        if (holding) {
          t.pendingAsk = result.itinerary;
          await this.save();
          await this.acceptAsk();
        } else {
          t.itinerary = result.itinerary; t.issues = [];
        }
        if (reapprove && !holding) {
          delete t.quote;
          quoteNote = `The quote changed to ${(result.totalCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}. Approve it again.`;
        }
      } else message = result.message;
    }
    t.lastAsk = { text, changed, message, reapprove, ...(quoteNote ? { quoteNote } : {}) };
    this.step('ask_agent', `You asked: ${text.replace(/[.!?\s]+$/, '')}. ${changed ? message : `No change was made. ${message}`}`, source, neurons);
  }
  private quote() {
    const t = this.trip;
    requireState(!t.payments.some(a => !['declined', 'expired', 'voided'].includes(a.state)) && !t.repair);
    const checked = validateSchedule(t.itinerary, t.ceilingCents);
    if (!checked.ok) throw new ApiError('INVALID_SCHEDULE', 'The itinerary must pass every check before payment.');
    t.quote = { version: t.itinerary.version, totalCents: t.itinerary.totalCents, approvedAt: this.now() }; t.phase = 'quoted';
  }
  private assertQuote() {
    const t = this.trip;
    requireState(t.quote && t.quote.version === t.itinerary.version, 'Approve the current quote first.');
    if (t.quote.totalCents !== t.itinerary.totalCents) throw new ApiError('AMOUNT_MISMATCH', 'The approved amount differs from the itinerary.');
  }
  private async pay(card: boolean, decline = false) {
    this.assertQuote();
    requireState(!this.trip.repair && !this.trip.compensation.length);
    const previous = latestAttempt(this.trip);
    if (previous && !['declined', 'expired', 'voided'].includes(previous.state)) {
      if (previous.state === 'none' && previous.method === (card ? 'card' : 'paypal')) {
        // A cap or token failure BEFORE the first send can retry its original persisted intent.
        await this.write(previous, createOrder(this.trip.id, previous.quoteVersion, previous.amountCents));
        if (card && (previous.state as string) === 'order_created') await this.authorizeCard(previous);
        if (previous.state as string === 'authorized') await this.reserve();
        return;
      }
      if (previous.method === (card ? 'card' : 'paypal')) {
        if (card && previous.state === 'order_created') {
          await this.authorizeCard(previous);
          if ((previous.state as string) === 'authorized') await this.reserve();
        }
        return; // Duplicate press returns its existing order/hold.
      }
      throw new ApiError('STATE', 'Finish the existing payment first.');
    }
    if (previous && previous.state !== 'voided') this.freshReservations();
    requireState(validateSchedule(this.trip.itinerary, this.trip.ceilingCents).ok);
    const a: PaymentAttempt = { quoteVersion: this.trip.quote!.version, amountCents: this.trip.quote!.totalCents, method: card ? 'card' : 'paypal', declineTest: decline, state: 'none', refunds: [], receipts: [] };
    this.trip.payments.push(a); await this.save();
    const result = await this.write(a, createOrder(this.trip.id, a.quoteVersion, a.amountCents));
    if (!result) return;
    if (card && a.state === 'order_created') await this.authorizeCard(a);
    if (a.state === 'authorized') await this.reserve();
  }
  private async authorizeCard(a: PaymentAttempt) {
    this.assertQuote();
    await this.write(a, authorizeOrder(a.orderId!, true, a.declineTest));
  }
  private freshReservations() {
    // New approval creates new supplier reservations; never transition a released/cancelled hold back to held.
    const t = this.trip;
    t.previous = { version: t.itinerary.version, items: structuredClone(t.itinerary.items) };
    t.itinerary.items = t.itinerary.items.filter(i => !['replaced', 'failed'].includes(i.state)).map(i => {
      const { supplierRef: _ref, ...rest } = i;
      return { ...rest, id: i.booked ? `${i.slot}-p${t.payments.length + 1}` : i.id, state: 'planned' };
    });
    this.step('reserve_demo_inventory', 'Simulated supplier: new reservations replace the released or cancelled attempt.');
  }
  private async authorize(orderId: unknown) {
    const a = latestAttempt(this.trip);
    requireState(a?.method === 'paypal');
    if (typeof orderId !== 'string' || orderId !== a.orderId) throw new ApiError('ORDER_MISMATCH', 'Use this trip’s stored PayPal order.', 400);
    if (a.state === 'authorized') return;
    requireState(a.state === 'order_created'); this.assertQuote();
    await this.write(a, authorizeOrder(a.orderId!));
    if (a.state as string === 'authorized') await this.reserve();
  }
  private async reserve() {
    requireState(latestAttempt(this.trip)?.state === 'authorized' && !this.trip.repair);
    for (let n = 0; n < this.trip.itinerary.items.length; n++) {
      const i = this.trip.itinerary.items[n];
      if (i.booked && i.state === 'planned') { this.trip.itinerary.items[n] = await this.deps.supplier.hold(i); await this.save(); }
    }
    this.step('reserve_demo_inventory', 'Simulated supplier: held every booked item.');
    this.trip.phase = 'holding';
  }
  private async releaseHolds() {
    for (let n = 0; n < this.trip.itinerary.items.length; n++) {
      const i = this.trip.itinerary.items[n];
      if (i.booked && i.state === 'held') {
        try { this.trip.itinerary.items[n] = await this.deps.supplier.release(i); }
        catch { if (!this.trip.compensation.includes(i.id)) this.trip.compensation.push(i.id); }
      }
    }
    this.showCompensation();
  }
  private showCompensation() {
    this.trip.issues = this.trip.issues.filter(i => !i.message.startsWith('Unresolved Simulated supplier'));
    for (const id of this.trip.compensation) this.trip.issues.push({ code: 'STATE', itemId: id, message: 'Unresolved Simulated supplier cancellation. Payment was not captured.' });
  }
  private async compensate() {
    this.trip.compensation = [];
    for (let n = 0; n < this.trip.itinerary.items.length; n++) {
      const i = this.trip.itinerary.items[n];
      try {
        if (i.booked && i.state === 'confirmed') this.trip.itinerary.items[n] = await this.deps.supplier.cancel(i);
        if (i.booked && i.state === 'held') this.trip.itinerary.items[n] = await this.deps.supplier.release(i);
      } catch { this.trip.compensation.push(i.id); }
    }
    this.showCompensation();
    this.step('reserve_demo_inventory', this.trip.compensation.length ? 'Simulated supplier: compensating cancellations remain unresolved; inspect the listed reservations.' : 'Simulated supplier: cancelled confirmed reservations and released holds after payment failure.');
  }
  private async hotelFailure() {
    requireState(latestAttempt(this.trip)?.state === 'authorized');
    if (this.trip.repair) return;
    const hotel = this.trip.itinerary.items.find(i => i.kind === 'lodging' && i.booked && i.state === 'held');
    requireState(hotel, 'There is no hotel hold to fail.');
    const failed = transition(hotel, 'failed');
    this.trip.itinerary.items[this.trip.itinerary.items.indexOf(hotel)] = failed;
    await this.proposeRepair(failed);
  }
  private async proposeRepair(hotel: Item, baseline = this.trip.itinerary) {
    const recordedRepair = this.deps.recorded.repair;
    this.trip.repairBase = structuredClone(baseline);
    const index = this.trip.repairBase.items.findIndex(i => i.id === hotel.id);
    if (this.trip.repairBase.items[index].state !== 'failed') this.trip.repairBase.items[index] = transition(this.trip.repairBase.items[index], 'failed');
    const policy = policyOf(this.trip);
    const repair = repairFailedLeg(this.trip.repairBase, hotel.id, this.trip.ceilingCents, policy);
    await this.releaseHolds();
    const checked = rankCandidates(repair.candidates, policy), choices = aiChoices(repair.candidates, policy);
    const rulePick = checked[0];
    const failedHotel = this.trip.repairBase.items.find(i => i.kind === 'lodging' && i.booked);
    let pickId = rulePick?.id ?? '', pickReason = rulePick
      ? `Rule pick: ${repairReason(rulePick, failedHotel?.name)}`
      : policy === 'keep_activities' ? `Rule pick: No replacement keeps every activity within your $${(this.trip.ceilingCents / 100).toFixed(2)} ceiling.`
      : 'Rule pick: lowest total, then fewest moves.', pickSource: PickSource = 'rule', neurons: number | undefined;
    // Persist a usable rule proposal before yielding to AI; an interrupted call cannot strand released holds.
    this.trip.repair = { failedItemId: hotel.id, candidates: repair.candidates, pickId, pickReason, pickSource };
    this.trip.previous = { version: this.trip.repairBase.version, items: structuredClone(this.trip.repairBase.items) };
    if (!this.trip.repairAsked && this.trip.aiCalls < MAX_AI_CALLS_PER_TRIP) {
      this.trip.repairAsked = true; this.trip.aiCalls++; await this.save();
      const live = choices.length ? await this.deps.ai.repairPick(choices, this.trip.tastes, policy) : null;
      if (live?.answer && choices.some(c => c.id === live.answer!.id)) {
        const chosen = choices.find(c => c.id === live.answer!.id)!;
        const oldHotel = this.trip.repairBase.items.find(i => i.kind === 'lodging' && i.booked);
        pickId = chosen.id;
        pickReason = `${repairReason(chosen, oldHotel?.name)}${live.answer.reason ? ` ${live.answer.reason}` : ' The AI gave no reason; this sentence is from the code checks.'}`;
        pickSource = 'live'; neurons = live.neurons; this.trip.repairAnswer = live.answer;
      } else if (live) {
        neurons = live.neurons;
      } else if (defaults(this.trip) && !recordedRepair.placeholder && recordedRepair.capturedAt && choices.some(c => c.id === recordedRepair.answer.id)) {
        pickId = recordedRepair.answer.id;
        const chosen = checked.find(c => c.id === pickId)!;
        const fit = tasteText(recordedRepair.answer.reason);
        pickReason = `Recorded answer from ${recordedRepair.capturedAt}. ${repairReason(chosen, failedHotel?.name)}${fit ? ` ${fit}` : ''}`;
        pickSource = 'recorded';
      }
    }
    this.trip.repair = { failedItemId: hotel.id, candidates: repair.candidates, pickId, pickReason, pickSource };
    this.trip.previous = { version: this.trip.repairBase.version, items: structuredClone(this.trip.repairBase.items) };
    this.step('repair_failed_leg', `Simulated supplier: hotel failed and other holds released. ${pickReason}`, pickSource, neurons);
    if (pickSource === 'live') this.trip.log.at(-1)!.aiWords = !pickReason.endsWith('The AI gave no reason; this sentence is from the code checks.');
  }
  private async accept(id: unknown) {
    const t = this.trip, a = latestAttempt(t);
    requireState(t.repair && t.repairBase && a);
    requireState(!t.compensation.length, 'Resolve the listed supplier releases first.');
    const candidate = t.repair.candidates.find(c => c.id === id && c.checks.ok);
    if (!candidate) throw new ApiError('INVALID_CANDIDATE', 'Choose a replacement that passed every check.', 400);
    requireState(canVoid(a)); t.pendingCandidateId = candidate.id;
    await this.voidAccepted(a);
  }
  private async acceptAsk() {
    const t = this.trip, a = latestAttempt(t);
    requireState(t.pendingAsk && a && canVoid(a));
    await this.releaseHolds();
    await this.save();
    if (t.compensation.length) return;
    await this.voidAccepted(a);
  }
  /** Both checked repairs and asks use the same durable void and completion path. */
  private async voidAccepted(a: PaymentAttempt) {
    const t = this.trip;
    try { await this.write(a, voidAuthorization(a.authorizationId!)); }
    catch (error) {
      if (!blockedByUnknown(t.payments)) { delete t.pendingCandidateId; await this.save(); }
      throw error;
    }
    if (a.state === 'voided') this.finishAccept();
  }
  private finishAccept() {
    const t = this.trip;
    const candidate = t.repair?.candidates.find(c => c.id === t.pendingCandidateId);
    requireState(t.pendingAsk || (candidate && t.repairBase));
    const asked = !!t.pendingAsk;
    const next = t.pendingAsk ?? applyCandidate(t.repairBase!, candidate!, policyOf(t));
    // Old holds have all been released. Each active row now describes a new reservation.
    next.items = next.items.map(i => {
      if (!isActive(i)) return i;
      const { supplierRef: _ref, ...rest } = i; return { ...rest, state: 'planned' };
    });
    t.itinerary = next; t.quote = { version: next.version, totalCents: next.totalCents, approvedAt: this.now() };
    t.phase = 'requote'; t.issues = validateSchedule(next, t.ceilingCents).issues;
    delete t.repair; delete t.repairBase; delete t.pendingCandidateId; delete t.pendingAsk;
    this.step('validate_schedule', `Accepted the checked ${asked ? 'change' : 'repair'} and new total. Old PayPal authorization voided. Pay again for this version.`);
  }
  private async authorizationRead(a: PaymentAttempt) {
    const result = await this.read(a, 'authorization', readAuthorization(a.authorizationId!));
    if (this.trip.fault === 'expire_authorization') {
      delete this.trip.fault;
      this.apply(a, 'authorization', { id: a.authorizationId, status: 'EXPIRED' });
    }
    return result;
  }
  private async confirm() {
    const t = this.trip, a = latestAttempt(t);
    requireState(a && !t.repair);
    if (a.state === 'captured') return;
    requireState(a.state === 'authorized'); this.assertQuote();
    if (a.amountCents !== t.quote!.totalCents) throw new ApiError('AMOUNT_MISMATCH', 'The authorization amount differs from the approved quote.');
    const result = await this.authorizationRead(a);
    if (!result || a.state !== 'authorized') {
      if (a.state as string === 'expired') { await this.releaseHolds(); await this.save(); throw new ApiError('AUTHORIZATION_EXPIRED', 'The authorization expired. Pay again with fresh approval.'); }
      await this.save(); throw new ApiError('PAYMENT_NOT_READY', 'The authorization could not be verified. Reconcile it first.');
    }
    let paypalCents = -1;
    try { if (result.body.amount?.currency_code === 'USD') paypalCents = toCents(result.body.amount.value); } catch { /* Invalid amounts must not reach capture. */ }
    if (paypalCents !== t.quote!.totalCents) {
      await this.save(); throw new ApiError('AMOUNT_MISMATCH', 'PayPal’s authorization amount differs from the approved quote.');
    }
    if (!a.expiresAt || Date.parse(a.expiresAt) <= this.deps.clock().getTime()) {
      a.state = 'expired'; await this.releaseHolds(); await this.save(); throw new ApiError('AUTHORIZATION_EXPIRED', 'The authorization expired. Pay again with fresh approval.');
    }
    const baseline = structuredClone(t.itinerary);
    for (let n = 0; n < t.itinerary.items.length; n++) {
      const i = t.itinerary.items[n];
      if (i.booked && i.state === 'held') { t.itinerary.items[n] = await this.deps.supplier.confirm(i); await this.save(); }
      if (t.itinerary.items[n].state === 'failed') break;
    }
    const failedHotel = t.itinerary.items.find(i => i.booked && i.kind === 'lodging' && i.state === 'failed');
    if (failedHotel) { await this.compensate(); await this.proposeRepair(failedHotel, baseline); return; }
    requireState(canCapture(a, t.itinerary.items, t.quote!, this.deps.clock()), 'Every reservation must be confirmed before capture.');
    await this.write(a, captureAuthorization(a.authorizationId!, t.quote!.totalCents));
    if (a.state as string === 'declined') await this.compensate();
  }
  private async cancelActivity() {
    const t = this.trip, a = latestAttempt(t);
    requireState(a?.state === 'captured' && a.captureId);
    if (a.refunds.length) return;
    const item = t.itinerary.items.find(i => i.offerId === 'a-tileclass' && i.state === 'confirmed') ?? t.itinerary.items.find(i => i.kind === 'activity' && i.state === 'confirmed' && i.priceCents > 0);
    requireState(item, 'There is no confirmed paid activity to cancel.');
    const cents = item.priceCents;
    requireState(canRefund(a, cents));
    const index = t.itinerary.items.indexOf(item);
    t.itinerary.items[index] = await this.deps.supplier.cancel(item);
    const repair = replanSlot(t.itinerary, item.id, t.ceilingCents);
    requireState(repair.checks.ok);
    t.previous = { version: t.itinerary.version, items: structuredClone(t.itinerary.items) }; t.itinerary = repair.itinerary;
    for (let n = 0; n < t.itinerary.items.length; n++) {
      const i = t.itinerary.items[n];
      if (i.booked && i.state === 'planned') t.itinerary.items[n] = await this.deps.supplier.confirm(await this.deps.supplier.hold(i));
    }
    requireState(canRefund(a, repair.refundCents));
    a.refunds.push({ amountCents: repair.refundCents, state: 'pending', reason: `Simulated supplier cancelled ${item.name} (${item.id}).` });
    this.step('replan_slot', `Simulated supplier: repaired the slot. ${repair.refundCents} cents remain outstanding until PayPal completes the refund.`);
    await this.write(a, refundCapture(a.captureId, repair.refundCents, t.id, a.refunds.length), `refund-${a.refunds.length}`);
  }
  private apply(a: PaymentAttempt, kind: 'order' | 'authorization' | 'capture' | 'refund', body: unknown) {
    Object.assign(a, applyPayPalRead(a, kind, body));
  }
  private async read(a: PaymentAttempt, kind: 'order' | 'authorization' | 'capture' | 'refund', path: string) {
    this.deps.paypal.onCall = async r => { a.receipts.push({ ...r, op: `read_${kind}`, at: this.now() }); await this.save(); };
    const result = await this.deps.paypal.request('GET', path);
    if (result.status >= 200 && result.status < 300 && !result.uncertain) { this.apply(a, kind, result.body); return result; }
    return null;
  }
  private async write(a: PaymentAttempt, spec: WriteSpec, suffix: string = spec.op, replay?: Operation): Promise<PayPalResult | null> {
    const index = this.trip.payments.indexOf(a), key = `${index}:${suffix}`;
    let op = replay ?? await this.store.getOp(key);
    if (!op) {
      op = { key, ...spec, attempt: index, requestId: crypto.randomUUID(), createdAt: this.now(), state: 'prepared' };
    }
    if (op.state === 'done') return null;
    if (op.state === 'failed') return null;
    // A sent authorize is only ever recovered by reading its stored order.
    if (op.op === 'authorize' && op.sent) { if (a.state !== 'unknown') a.previousState = a.state; a.state = 'unknown'; await this.save(); return null; }
    if (replay && op.sent && this.deps.clock().getTime() - Date.parse(op.createdAt) > 6 * 60 * 60 * 1_000) return null;
    const before = a.state === 'unknown' ? a.previousState ?? 'none' : a.state;
    a.previousState = before; a.state = 'unknown';
    if (op.op === 'refund') a.refunds.at(-1)!.state = 'unknown';
    // Save the exact intent AND its Checking payment state together, before any outgoing write.
    this.refresh(); await this.store.checkpoint(this.trip, op);
    let sent = false;
    // The card fault drops its financial step, after the safe order creation.
    const loseResponse = this.trip.fault === 'lose_next_response' && !(op.op === 'create' && a.method === 'card');
    this.deps.paypal.onCall = async r => {
      a.receipts.push({ ...(loseResponse ? { method: r.method, path: r.path, requestId: r.requestId, status: 0, paypalStatus: 'RESPONSE_LOST' } : r), op: op!.op, at: this.now() });
      await this.save();
    };
    let result: PayPalResult;
    try {
      result = await this.deps.paypal.request('POST', op.path, op.body, { requestId: op.requestId, headers: op.headers, retry: op.op !== 'authorize', beforeSend: async () => {
        if (this.trip.writes >= MAX_PAYPAL_WRITES_PER_TRIP) throw new ApiError('PAYPAL_CAP', 'This trip reached its PayPal write limit.', 429);
        await this.deps.gate.takeWrite(); this.trip.writes++;
        op!.sent = true; this.refresh(); await this.store.checkpoint(this.trip, op!); sent = true;
      } });
    } catch (e) {
      if (!sent) { a.state = before; delete a.previousState; if (op.op === 'refund') a.refunds.at(-1)!.state = 'pending'; await this.save(); throw e; }
      await this.save(); return null;
    }
    if (loseResponse) {
      delete this.trip.fault;
      // The write above really ran. Do not retain its body as an operation result.
      await this.save(); return null;
    }
    if (result.uncertain || result.status === 0 || (result.status >= 300 && result.status < 400)) { await this.save(); return null; }
    // A replay refusal says nothing about the original write. Keep it pending for reads.
    if (replay && result.status >= 400) { await this.save(); return null; }
    if (result.status >= 200 && result.status < 300) {
      if (op.op === 'void' && result.status === 204) this.apply(a, 'authorization', { id: a.authorizationId, status: 'VOIDED' });
      else this.apply(a, readKind(op.op), result.body);
      // A syntactically successful but incomplete reply cannot unlock the trip.
      if (a.state === 'unknown' || a.refunds.some(r => r.state === 'unknown')) { await this.save(); return null; }
      op.state = 'done'; op.result = result.body;
    } else {
      op.state = 'failed'; op.result = result.body;
      a.state = before; delete a.previousState;
      if (['create', 'authorize', 'capture'].includes(op.op)) { a.state = 'declined'; await this.releaseHolds(); }
      if (op.op === 'refund') a.refunds.at(-1)!.state = 'failed';
      this.step('paypal', `PayPal ${op.op} refused: ${result.errorName ?? result.status}.`);
    }
    op.outcomeStatus = result.status;
    this.refresh(); await this.store.checkpoint(this.trip, op); return result;
  }
  private async reconcile() {
    const t = this.trip;
    const operations = await this.store.ops();
    const pending = operations.filter(o => o.state === 'prepared' && (o.sent || o.op === 'refund'));
    for (const a of t.payments) {
      // The process can stop after persisting an operation's outcome and before saving trip JSON.
      // Recover those known outcomes first; otherwise a lost create/refund id could remain stuck.
      for (const op of operations.filter(o => o.attempt === t.payments.indexOf(a) && o.state !== 'prepared')) {
        if (op.state === 'done' && op.result) {
          if (op.op === 'void' && op.outcomeStatus === 204) this.apply(a, 'authorization', { id: a.authorizationId, status: 'VOIDED' });
          else this.apply(a, readKind(op.op), op.result);
        } else if (op.state === 'failed') {
          if (['create', 'authorize', 'capture'].includes(op.op) && a.state !== 'captured') a.state = 'declined';
          else if (a.state === 'unknown') a.state = a.previousState ?? 'none';
          delete a.previousState;
          if (op.op === 'refund' && a.refunds.at(-1)!.state !== 'completed') a.refunds.at(-1)!.state = 'failed';
        }
      }
      // Unknown create/refund replies can lack the resource id. A bounded SAME-id replay recovers
      // it within PayPal's default six-hour Orders idempotency window, never a fresh operation.
      for (const op of pending.filter(o => o.attempt === t.payments.indexOf(a))) {
        if ((op.op === 'create' && !a.orderId) || (op.op === 'refund' && a.refunds.some(r => !r.id && ['unknown', 'pending'].includes(r.state)))) {
          await this.write(a, op, op.key.split(':').slice(1).join(':'), op);
        }
      }
      if (a.orderId) await this.read(a, 'order', readOrder(a.orderId));
      if (a.authorizationId) await this.authorizationRead(a);
      if (a.captureId) await this.read(a, 'capture', readCapture(a.captureId));
      for (const r of a.refunds) if (r.id) await this.read(a, 'refund', readRefund(r.id));
      for (const op of pending.filter(o => o.attempt === t.payments.indexOf(a))) {
        const resolved = op.op === 'create' ? !!a.orderId : op.op === 'authorize' ? ['authorized', 'expired', 'voided', 'declined', 'captured'].includes(a.state) : op.op === 'void' ? a.state === 'voided' : op.op === 'capture' ? ['captured', 'declined'].includes(a.state) : a.refunds.every(r => !['unknown', 'pending'].includes(r.state));
        // An order/authorization read alone must NOT erase uncertainty about a sent capture/void/refund.
        if (resolved) { op.state = 'done'; await this.store.putOp(op); }
        else if (!(op.op === 'refund' && a.refunds.some(r => r.id && r.state === 'pending'))) {
          a.previousState = a.state === 'unknown' ? a.previousState : a.state; a.state = 'unknown';
        }
      }
      // A safe create replay may have recovered the id before the financial step was sent.
      // Unsent operations can proceed; a sent authorize is NEVER replayed.
      if (a.method === 'card' && a.state === 'order_created') {
        const auth = operations.find(o => o.attempt === t.payments.indexOf(a) && o.op === 'authorize');
        if (!auth?.sent && !blockedByUnknown(t.payments)) await this.authorizeCard(a);
      }
    }
    const a = latestAttempt(t);
    if (!blockedByUnknown(t.payments)) {
      if (a?.state === 'authorized' && t.pendingAsk) await this.acceptAsk();
      else if (a?.state === 'authorized' && !t.repair) await this.reserve();
      if (a && ['declined', 'expired'].includes(a.state)) await this.compensate();
      if (t.compensation.length) await this.compensate();
      if (a?.state === 'voided' && (t.pendingCandidateId || t.pendingAsk)) this.finishAccept();
    }
    this.step('paypal', 'Read PayPal resources and reconciled the original operations.');
  }
  async webhook(event: PayPalEvent): Promise<void> {
    await this.load();
    if (await this.store.hasEvent(event.id)) return;
    if (this.trip.webhooks?.some(row => row.eventId === event.id)) {
      await this.store.putEvent(event.id); // Recover the save-before-deduplication boundary without adding a second row.
      return;
    }
    const custom = event.resource.custom_id as string;
    const match = new RegExp(`^rr-${this.trip.id}-(v|r)(\\d+)$`).exec(custom);
    if (!match) return;
    const isRefund = match[1] === 'r' && event.event_type === 'PAYMENT.CAPTURE.REFUNDED';
    const kind = isRefund ? 'refund' : event.event_type.startsWith('PAYMENT.AUTHORIZATION.') ? 'authorization' : 'capture';
    const attempts = this.trip.payments.slice().reverse();
    const known = (p: PaymentAttempt) => kind === 'refund' ? p.refunds.some(r => r.id === event.resource.id) : p[kind === 'authorization' ? 'authorizationId' : 'captureId'] === event.resource.id;
    const a = attempts.find(p => (match[1] === 'r' || p.quoteVersion === Number(match[2])) && known(p)) ?? attempts.find(p => {
      if (isRefund) return p.refunds[Number(match[2]) - 1]?.id === undefined && ['unknown', 'pending'].includes(p.refunds[Number(match[2]) - 1]?.state ?? '');
      if (p.quoteVersion !== Number(match[2]) || !['unknown', 'order_created', 'authorized', 'capturing'].includes(p.state)) return false;
      const id = p[kind === 'authorization' ? 'authorizationId' : 'captureId'];
      const order = event.resource.supplementary_data?.related_ids?.order_id;
      return !id && (!order || !p.orderId || p.orderId === order);
    });
    if (!a) return; // A verified but untracked resource cannot change another attempt.
    const previousState = a.state;
    const previousRefunds = JSON.stringify(a.refunds.map(refund => [refund.id, refund.state]));
    this.apply(a, kind, event.resource);
    const nextState = a.state;
    const changed = nextState !== previousState || JSON.stringify(a.refunds.map(refund => [refund.id, refund.state])) !== previousRefunds;
    let outcome: WebhookReceipt['outcome'] = changed ? 'applied' : 'already known';
    const status = String(event.resource.status ?? '').toUpperCase();
    if (!changed && ((['captured', 'refunded'].includes(previousState) && ['CREATED', 'VOIDED'].includes(status)) ||
      (previousState === 'voided' && status === 'CREATED'))) outcome = 'ignored (older than the current state)';
    this.trip.webhooks ??= [];
    this.trip.webhooks.push({ eventId: event.id, eventType: event.event_type, ...(event.create_time ? { createTime: event.create_time } : {}),
      receivedAt: this.now(), signatureVerified: true, quoteVersion: a.quoteVersion,
      ...(typeof event.resource.id === 'string' ? { resourceId: event.resource.id } : {}), outcome });
    this.trip.webhooks = this.trip.webhooks.slice(-50);
    if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED' && !isRefund) {
      // A capture REFUNDED event is not evidence that a particular partial refund completed.
      for (const refund of a.refunds) if (refund.id) await this.read(a, 'refund', readRefund(refund.id));
    }
    // Reconcile pending operations before unlocking; late authorization events cannot unlock a lost capture.
    if ((await this.store.ops()).some(o => o.state === 'prepared')) await this.reconcile();
    if (a.state === 'declined') await this.compensate();
    await this.save();
    await this.store.putEvent(event.id); // Save state first: interrupted event processing can safely resume.
  }
  async recordAnswers(sid: string) {
    await this.load(sid);
    requireState(defaults(this.trip) && this.trip.proposalAnswer && !this.trip.repairAsked && !this.trip.asks && this.trip.aiCalls < MAX_AI_CALLS_PER_TRIP, 'A fresh live proposal is required to record answers.');
    const hotel = this.trip.itinerary.items.find(i => i.kind === 'lodging' && i.booked)!;
    const candidates = repairFailedLeg(this.trip.itinerary, hotel.id, this.trip.ceilingCents).candidates;
    this.trip.aiCalls++; this.trip.repairAsked = true; await this.save();
    const result = await this.deps.ai.repairPick(aiChoices(candidates), this.trip.tastes, 'lowest_total');
    requireState(result?.answer, 'Live repair AI is unavailable or unusable. No recorded answer was saved.');
    this.trip.repairAnswer = result.answer; await this.save();
    return { propose: this.trip.proposalAnswer, repair: result.answer, capturedAt: this.now() };
  }
}
