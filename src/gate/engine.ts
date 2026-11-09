import { CACHE_TTL_MS, MAX_TRIPS_PER_DAY, MAX_TRIPS_PER_SID_DAY, MAX_PAYPAL_WRITES_PER_DAY } from '../caps';
import { ApiError } from '../errors';
import type { Proposal } from '../ai/agent';
export interface CachedProposal { answer: Proposal; capturedAt: string }
export interface Gate {
  takeTrip(sid: string): Promise<void>;
  takeWrite(): Promise<void>;
  cached(key: string): Promise<CachedProposal | null>;
  cache(key: string, answer: CachedProposal): Promise<void>;
}
export async function proposalKey(tastes: string[], note: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([[...new Set(tastes)].sort(), note]));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export class MemoryGate implements Gate {
  counts = new Map<string, number>(); answers = new Map<string, CachedProposal>();
  constructor(private clock = () => new Date()) {}
  private key(key: string) { return this.clock().toISOString().slice(0, 10) + ':' + key; }
  async takeTrip(sid: string) {
    const total = this.key('trips'), user = this.key('sid:' + sid);
    if ((this.counts.get(total) ?? 0) >= MAX_TRIPS_PER_DAY || (this.counts.get(user) ?? 0) >= MAX_TRIPS_PER_SID_DAY) throw new ApiError('TRIP_CAP', 'Today’s trip limit is reached. Try after 00:00 UTC.', 429);
    this.counts.set(total, (this.counts.get(total) ?? 0) + 1); this.counts.set(user, (this.counts.get(user) ?? 0) + 1);
  }
  async takeWrite() {
    const key = this.key('writes');
    if ((this.counts.get(key) ?? 0) >= MAX_PAYPAL_WRITES_PER_DAY) throw new ApiError('PAYPAL_CAP', 'Today’s PayPal limit is reached. Try after 00:00 UTC.', 429);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  async cached(key: string) {
    const answer = this.answers.get(key);
    return answer && this.clock().getTime() - Date.parse(answer.capturedAt) < CACHE_TTL_MS ? structuredClone(answer) : null;
  }
  async cache(key: string, answer: CachedProposal) { this.answers.set(key, structuredClone(answer)); }
}
