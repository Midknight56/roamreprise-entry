import type { Itinerary, PaymentAttempt, TripView } from '../domain/types';
export type OperationKind = 'create' | 'authorize' | 'capture' | 'void' | 'refund';
export interface Operation {
  key: string; op: OperationKind; requestId: string; body: Record<string, unknown>;
  path: string; attempt: number; createdAt: string; headers?: Record<string, string>;
  state: 'prepared' | 'done' | 'failed'; sent?: boolean; result?: Record<string, any>; outcomeStatus?: number;
}
export interface TripRecord extends TripView {
  sid: string; writes: number; aiCalls: number; repairAsked?: boolean; asks?: number;
  pendingCandidateId?: string; compensation: string[];
  pendingAsk?: Itinerary;
  fault?: 'lose_next_response' | 'expire_authorization';
  proposalAnswer?: unknown; repairAnswer?: unknown;
  repairBase?: Itinerary;
}
export interface TripStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  getOp(key: string): Promise<Operation | undefined>;
  putOp(op: Operation): Promise<void>;
  checkpoint(trip: TripRecord, op: Operation): Promise<void>;
  ops(): Promise<Operation[]>;
  hasEvent(id: string): Promise<boolean>;
  putEvent(id: string): Promise<void>;
}
export class MemoryStore implements TripStore {
  data = new Map<string, unknown>(); operations = new Map<string, Operation>(); events = new Set<string>();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.data.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.data.set(key, structuredClone(value)); }
  async getOp(key: string) { return structuredClone(this.operations.get(key)); }
  async putOp(op: Operation) { this.operations.set(op.key, structuredClone(op)); }
  async checkpoint(trip: TripRecord, op: Operation) { this.data.set('trip', structuredClone(trip)); this.operations.set(op.key, structuredClone(op)); }
  async ops() { return structuredClone([...this.operations.values()]); }
  async hasEvent(id: string) { return this.events.has(id); }
  async putEvent(id: string) { this.events.add(id); }
}
export class SqlTripStore implements TripStore {
  constructor(private sql: SqlStorage, private transaction: <T>(fn: () => T) => T) {
    sql.exec('CREATE TABLE IF NOT EXISTS trip_json (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS ops (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY)');
  }
  async get<T>(key: string): Promise<T | undefined> {
    const row = this.sql.exec<{value: string}>('SELECT value FROM trip_json WHERE key = ?', key).toArray()[0];
    return row ? JSON.parse(row.value) as T : undefined;
  }
  async put<T>(key: string, value: T) { this.sql.exec('INSERT OR REPLACE INTO trip_json VALUES (?, ?)', key, JSON.stringify(value)); }
  async getOp(key: string) {
    const row = this.sql.exec<{value: string}>('SELECT value FROM ops WHERE key = ?', key).toArray()[0];
    return row ? JSON.parse(row.value) as Operation : undefined;
  }
  async putOp(op: Operation) { this.sql.exec('INSERT OR REPLACE INTO ops VALUES (?, ?)', op.key, JSON.stringify(op)); }
  async checkpoint(trip: TripRecord, op: Operation) {
    this.transaction(() => {
      this.sql.exec('INSERT OR REPLACE INTO trip_json VALUES (?, ?)', 'trip', JSON.stringify(trip));
      this.sql.exec('INSERT OR REPLACE INTO ops VALUES (?, ?)', op.key, JSON.stringify(op));
    });
  }
  async ops() { return this.sql.exec<{value: string}>('SELECT value FROM ops').toArray().map(r => JSON.parse(r.value) as Operation); }
  async hasEvent(id: string) { return this.sql.exec('SELECT id FROM events WHERE id = ?', id).toArray().length > 0; }
  async putEvent(id: string) { this.sql.exec('INSERT OR IGNORE INTO events VALUES (?)', id); }
}
export const latestAttempt = (trip: TripRecord): PaymentAttempt | undefined => trip.payments.at(-1);
