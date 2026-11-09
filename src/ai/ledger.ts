import type { NeuronLedger } from './model';
/** Adapted from Circlekeeper (MIT): one SQLite statement reserves against BOTH budgets atomically. */
export class D1Ledger implements NeuronLedger {
  constructor(private db: D1Database, private now: () => Date = () => new Date()) {}
  async charge(app: string, day: string, neurons: number, appLimit: number, accountLimit: number): Promise<string | null> {
    const row = await this.db.prepare(`INSERT INTO ai_calls (app, day, neurons, at)
      SELECT ?1, ?2, ?3, ?4
      WHERE (SELECT COALESCE(SUM(neurons), 0) FROM ai_calls WHERE app = ?1 AND day = ?2) + ?3 <= ?5
        AND (SELECT COALESCE(SUM(neurons), 0) FROM ai_calls WHERE day = ?2) + ?3 <= ?6
      RETURNING id`).bind(app, day, neurons, this.now().toISOString(), appLimit, accountLimit).first<{id: number}>();
    return row ? String(row.id) : null;
  }
  async settle(id: string, neurons: number) { await this.db.prepare('UPDATE ai_calls SET neurons = ?1 WHERE id = ?2').bind(neurons, Number(id)).run(); }
  async spent(app: string, day: string) {
    return (await this.db.prepare('SELECT COALESCE(SUM(neurons), 0) AS n FROM ai_calls WHERE app = ?1 AND day = ?2').bind(app, day).first<{n: number}>())?.n ?? 0;
  }
}
export class MemoryLedger implements NeuronLedger {
  rows: { id: string; app: string; day: string; neurons: number }[] = [];
  async charge(app: string, day: string, neurons: number, appLimit: number, accountLimit: number) {
    const sum = (all: boolean) => this.rows.filter(r => r.day === day && (all || r.app === app)).reduce((n, r) => n + r.neurons, 0);
    if (sum(false) + neurons > appLimit || sum(true) + neurons > accountLimit) return null;
    const id = String(this.rows.length + 1); this.rows.push({ id, app, day, neurons }); return id;
  }
  async settle(id: string, neurons: number) { const row = this.rows.find(r => r.id === id); if (row) row.neurons = neurons; }
  async spent(app: string, day: string) { return this.rows.filter(r => r.app === app && r.day === day).reduce((n, r) => n + r.neurons, 0); }
}
