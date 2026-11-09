import { ACCOUNT_DAILY_NEURONS_GUARD, DAILY_NEURONS, INPUT_NEURONS_PER_MILLION, MAX_INPUT_CHARS, MAX_OUTPUT_TOKENS, MODEL_ID, OUTPUT_NEURONS_PER_MILLION, RESERVED_NEURONS, utcDay } from '../caps';
export interface NeuronLedger {
  charge(app: string, day: string, neurons: number, appLimit: number, accountLimit: number): Promise<string | null>;
  settle(id: string, neurons: number): Promise<void>;
  spent(app: string, day: string): Promise<number>;
}
export interface ModelAnswer { text: string; neurons: number }
export interface Model { call(system: string, user: string): Promise<ModelAnswer | null> }
export interface AiBinding { run(model: string, input: { messages: { role: 'system' | 'user'; content: string }[]; response_format: { type: 'json_object' }; max_tokens: number }): Promise<unknown> }
export class BoundedModel implements Model {
  constructor(private ai: AiBinding, private ledger: NeuronLedger, private live: string, private clock = () => new Date()) {}
  async call(system: string, user: string): Promise<ModelAnswer | null> {
    if (this.live !== '1') return null;
    let id: string | null;
    try { id = await this.ledger.charge('roamreprise', utcDay(this.clock()), RESERVED_NEURONS, DAILY_NEURONS, ACCOUNT_DAILY_NEURONS_GUARD); }
    catch { return null; } // Ledger errors fail closed: no model call.
    if (!id) return null;
    try {
      const combined = (system + '\n' + user).slice(0, MAX_INPUT_CHARS);
      const systemLength = Math.min(system.length, combined.length);
      const raw = await this.ai.run(MODEL_ID, { messages: [{ role: 'system', content: combined.slice(0, systemLength) }, { role: 'user', content: combined.slice(systemLength).replace(/^\n/, '') }], response_format: { type: 'json_object' }, max_tokens: MAX_OUTPUT_TOKENS }) as { choices?: { message?: { content?: unknown }; text?: unknown }[]; response?: unknown; usage?: { neurons?: number; prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } };
      let neurons = RESERVED_NEURONS;
      if (typeof raw.usage?.neurons === 'number' && Number.isFinite(raw.usage.neurons)) neurons = raw.usage.neurons;
      const input = raw.usage?.prompt_tokens ?? raw.usage?.input_tokens;
      const output = raw.usage?.completion_tokens ?? raw.usage?.output_tokens;
      if (typeof raw.usage?.neurons !== 'number' && typeof input === 'number' && typeof output === 'number' && Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) {
        neurons = (input * INPUT_NEURONS_PER_MILLION + output * OUTPUT_NEURONS_PER_MILLION) / 1_000_000;
      }
      await this.ledger.settle(id, neurons);
      const content = raw.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content : typeof raw.response === 'string' ? raw.response : raw.response && typeof raw.response === 'object' ? JSON.stringify(raw.response) : undefined;
      return text === undefined ? { text: '', neurons } : { text, neurons };
    } catch { return null; } // Missing usage, failure, or failed settlement keeps the reservation.
  }
}
