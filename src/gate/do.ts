import { DurableObject } from 'cloudflare:workers';
import { CACHE_TTL_MS, MAX_PAYPAL_WRITES_PER_DAY, MAX_TRIPS_PER_DAY, MAX_TRIPS_PER_SID_DAY, utcDay } from '../caps';
import type { CachedProposal } from './engine';
import type { Env } from '../env';
export class GateDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counters (day TEXT, key TEXT, n INTEGER NOT NULL, PRIMARY KEY(day,key))');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS proposal_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)');
  }
  private count(day: string, key: string) { return this.ctx.storage.sql.exec<{n: number}>('SELECT n FROM counters WHERE day = ? AND key = ?', day, key).toArray()[0]?.n ?? 0; }
  private add(day: string, key: string) { this.ctx.storage.sql.exec('INSERT INTO counters VALUES (?, ?, 1) ON CONFLICT(day,key) DO UPDATE SET n=n+1', day, key); }
  // No awaits inside each transaction: all consumers of this one named DO see an atomic limit.
  async takeTrip(sid: string): Promise<boolean> {
    const day = utcDay(new Date());
    return this.ctx.storage.transactionSync(() => {
      if (this.count(day, 'trips') >= MAX_TRIPS_PER_DAY || this.count(day, 'sid:' + sid) >= MAX_TRIPS_PER_SID_DAY) return false;
      this.add(day, 'trips'); this.add(day, 'sid:' + sid);
      this.ctx.storage.sql.exec('DELETE FROM counters WHERE day < ?', day);
      return true;
    });
  }
  async takeWrite(): Promise<boolean> {
    const day = utcDay(new Date());
    return this.ctx.storage.transactionSync(() => {
      if (this.count(day, 'writes') >= MAX_PAYPAL_WRITES_PER_DAY) return false;
      this.add(day, 'writes');
      return true;
    });
  }
  async cached(key: string): Promise<CachedProposal | null> {
    const row = this.ctx.storage.sql.exec<{value: string}>('SELECT value FROM proposal_cache WHERE key = ? AND expires > ?', key, Date.now()).toArray()[0];
    return row ? JSON.parse(row.value) as CachedProposal : null;
  }
  async cache(key: string, answer: CachedProposal): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM proposal_cache WHERE expires <= ?', Date.now());
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO proposal_cache VALUES (?, ?, ?)', key, JSON.stringify(answer), Date.now() + CACHE_TTL_MS);
  }
}
