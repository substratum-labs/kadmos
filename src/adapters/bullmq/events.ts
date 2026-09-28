import { EventEmitter } from "node:events";
import { keys } from "./lifecycle.js";
import { resolveRedis, type RedisListener, type RedisTransport } from "./redis.js";
import type { QueueOptions } from "./types.js";

export class QueueEvents extends EventEmitter {
  readonly name: string;
  readonly prefix: string;
  private readonly redis: RedisTransport;
  private readonly listener: RedisListener;
  readonly ready: Promise<void>;
  constructor(name: string, opts: QueueOptions = {}) {
    super(); this.name = name; this.prefix = opts.prefix ?? "kadmos"; this.redis = resolveRedis(opts.connection);
    this.listener = message => {
      try { const { event, ...payload } = JSON.parse(message) as { event: string }; this.emit(event, payload); }
      catch (error) { this.emit("error", error); }
    };
    this.ready = this.redis.subscribe(keys(this.prefix, this.name).events, this.listener);
  }
  async close(): Promise<void> { await this.ready; await this.redis.unsubscribe(keys(this.prefix, this.name).events, this.listener); }
}
