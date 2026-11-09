import { offer } from './offers';
import { transition } from './reservations';
import { SUPPLIER, type Item } from './types';
export interface ScenarioFlags { hotelUnavailable?: boolean; cancelActivityId?: string }
export class SimulatedSupplier {
  readonly supplier = SUPPLIER;
  private seed = 2166136261;
  constructor(tripId: string, public flags: ScenarioFlags = {}) {
    for (const char of tripId) this.seed = Math.imul(this.seed ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  private ref(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let ref = 'SIM-';
    for (let i = 0; i < 6; i++) { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; ref += alphabet[this.seed >>> 27]; }
    return ref;
  }
  hold(item: Item): Item & { supplier: typeof SUPPLIER } {
    const held = transition(item, 'held');
    const unavailable = item.kind === 'lodging' && !offer(item.offerId).available;
    return { ...(unavailable ? transition(held, 'failed') : held), supplierRef: item.supplierRef ?? this.ref(), supplier: SUPPLIER };
  }
  confirm(item: Item): Item & { supplier: typeof SUPPLIER } {
    const fail = item.kind === 'lodging' && (this.flags.hotelUnavailable || !offer(item.offerId).available);
    return { ...transition(item, fail ? 'failed' : 'confirmed'), supplier: SUPPLIER };
  }
  release(item: Item): Item & { supplier: typeof SUPPLIER } { return { ...transition(item, 'released'), supplier: SUPPLIER }; }
  cancel(item: Item): Item & { supplier: typeof SUPPLIER } {
    if (this.flags.cancelActivityId && item.offerId !== this.flags.cancelActivityId && item.id !== this.flags.cancelActivityId) throw Object.assign(new Error('STATE: This is not the cancelled activity.'), { code: 'STATE' });
    return { ...transition(item, 'cancelled'), supplier: SUPPLIER };
  }
}
