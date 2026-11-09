import { DurableObject } from 'cloudflare:workers';
import { Agent } from '../ai/agent';
import { D1Ledger } from '../ai/ledger';
import { BoundedModel } from '../ai/model';
import { SimulatedSupplier } from '../domain/supplier';
import type { Env } from '../env';
import { ApiError, errorResponse } from '../errors';
import type { Gate } from '../gate/engine';
import { PayPal } from '../paypal/client';
import type { PayPalEvent } from '../paypal/webhooks';
import { SerialQueue } from '../queue';
import { TripEngine, tripInput } from './engine';
import { SqlTripStore } from './store';
import propose from '../recorded/default-propose.json';
import repair from '../recorded/default-repair.json';
export class TripDO extends DurableObject<Env> {
  private queue = new SerialQueue();
  private engine: TripEngine;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const stub = env.GATE.getByName('gate');
    const gate: Gate = {
      async takeTrip(sid) { if (!await stub.takeTrip(sid)) throw new ApiError('TRIP_CAP', 'Today’s trip limit is reached. Try after 00:00 UTC.', 429); },
      async takeWrite() { if (!await stub.takeWrite()) throw new ApiError('PAYPAL_CAP', 'Today’s PayPal limit is reached. Try after 00:00 UTC.', 429); },
      cached: key => stub.cached(key), cache: (key, value) => stub.cache(key, value),
    };
    this.engine = new TripEngine({ store: new SqlTripStore(ctx.storage.sql, fn => ctx.storage.transactionSync(fn)), paypal: new PayPal(env),
      ai: new Agent(new BoundedModel({ run: (model, input) => env.AI.run(model as Parameters<Ai['run']>[0], input) }, new D1Ledger(env.LEDGER), env.LIVE_AI)),
      recorded: { propose, repair }, gate, clock: () => new Date(), supplier: new SimulatedSupplier(ctx.id.toString()) });
  }
  // The sole business entry point: serialization spans external PayPal/AI fetches and errors.
  async request(id: string, sid: string, action: string, body: Record<string, unknown> = {}): Promise<Response> {
    return this.queue.run(async () => {
      try {
        if (action === 'dev/fault' && this.env.DEV_ROUTES !== '1') throw new ApiError('NOT_FOUND', 'Route not found.', 404);
        const result = action === 'create' ? await this.engine.create(id, sid, tripInput(body)) : action === 'get' ? await this.engine.get(sid) : await this.engine.action(sid, action, body);
        return Response.json(result, { status: action === 'create' ? 201 : 200 });
      } catch (error) { return errorResponse(error); }
    });
  }
  async receiveEvent(event: PayPalEvent): Promise<void> { return this.queue.run(() => this.engine.webhook(event)); }
  async record(id: string, sid: string, body: Record<string, unknown>): Promise<Response> {
    return this.queue.run(async () => {
      try {
        if (this.env.DEV_ROUTES !== '1') throw new ApiError('NOT_FOUND', 'Route not found.', 404);
        await this.engine.create(id, sid, tripInput(body));
        return Response.json(await this.engine.recordAnswers(sid));
      } catch (error) { return errorResponse(error); }
    });
  }
}
