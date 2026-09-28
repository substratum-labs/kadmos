import { EventEmitter } from "node:events";

export type RedisListener = (message: string) => void;
export interface JobTransition {
  jobKey: string;
  id: string;
  expectedState: string;
  expectedToken?: string | undefined;
  expectedLease?: string | undefined;
  requireList?: string | undefined;
  changes: Record<string, string>;
  removeList?: string;
  pushList?: string;
  removeSet?: string;
  addSet?: { key: string; score: number };
}
export interface RedisTransport {
  lpush(key: string, value: string): Promise<number>;
  lpop(key: string): Promise<string | null>;
  lrem(key: string, count: number, value: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  llen(key: string): Promise<number>;
  rpoplpush(source: string, destination: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  hset(key: string, field: string | Record<string, string>, value?: string): Promise<number>;
  hsetnx(key: string, field: string, value: string): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  transitionJob(change: JobTransition): Promise<boolean>;
  zadd(key: string, score: number, value: string): Promise<number>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrem(key: string, value: string): Promise<number>;
  zcard(key: string): Promise<number>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: RedisListener): Promise<void>;
  unsubscribe(channel: string, listener: RedisListener): Promise<void>;
  close?(): Promise<void>;
}

export class MemoryRedis implements RedisTransport {
  private readonly lists = new Map<string, string[]>();
  private readonly strings = new Map<string, string>();
  private readonly hashes = new Map<string, Record<string, string>>();
  private readonly sets = new Map<string, Map<string, number>>();
  private readonly bus = new EventEmitter();
  async lpush(key: string, value: string): Promise<number> { const list = this.lists.get(key) ?? []; list.unshift(value); this.lists.set(key, list); return list.length; }
  async lpop(key: string): Promise<string | null> { return this.lists.get(key)?.shift() ?? null; }
  async lrem(key: string, count: number, value: string): Promise<number> {
    const list = this.lists.get(key) ?? []; let removed = 0;
    if (count <= 0) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i] === value && (count === 0 || removed < -count)) { list.splice(i, 1); removed++; }
    } else {
      for (let i = 0; i < list.length && removed < count;) {
        if (list[i] === value) { list.splice(i, 1); removed++; }
        else i++;
      }
    }
    return removed;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    return list.slice(start, stop === -1 ? undefined : stop + 1);
  }
  async llen(key: string): Promise<number> { return this.lists.get(key)?.length ?? 0; }
  async rpoplpush(source: string, destination: string): Promise<string | null> {
    const item = this.lists.get(source)?.pop(); if (item === undefined) return null;
    await this.lpush(destination, item); return item;
  }
  async set(key: string, value: string): Promise<string> { this.strings.set(key, value); return "OK"; }
  async get(key: string): Promise<string | null> { return this.strings.get(key) ?? null; }
  async del(key: string): Promise<number> { return Number(this.lists.delete(key)) + Number(this.strings.delete(key)) + Number(this.hashes.delete(key)) + Number(this.sets.delete(key)); }
  async hset(key: string, field: string | Record<string, string>, value?: string): Promise<number> {
    const hash = this.hashes.get(key) ?? {}; const fields = typeof field === "string" ? { [field]: value ?? "" } : field;
    let added = 0; for (const [name, data] of Object.entries(fields)) { if (!Object.hasOwn(hash, name)) added++; hash[name] = data; }
    this.hashes.set(key, hash); return added;
  }
  async hsetnx(key: string, field: string, value: string): Promise<number> {
    const hash = this.hashes.get(key) ?? {};
    if (Object.hasOwn(hash, field)) return 0;
    hash[field] = value; this.hashes.set(key, hash); return 1;
  }
  async hgetall(key: string): Promise<Record<string, string>> { return { ...(this.hashes.get(key) ?? {}) }; }
  async transitionJob(change: JobTransition): Promise<boolean> {
    const hash = this.hashes.get(change.jobKey);
    if (!hash || hash.state !== change.expectedState) return false;
    if (change.expectedToken !== undefined && hash.lockToken !== change.expectedToken) return false;
    if (change.expectedLease !== undefined && hash.lockAcquiredAt !== change.expectedLease) return false;
    if (change.requireList && !(this.lists.get(change.requireList) ?? []).includes(change.id)) return false;
    Object.assign(hash, change.changes);
    if (change.removeList) this.lists.set(change.removeList, (this.lists.get(change.removeList) ?? []).filter(id => id !== change.id));
    if (change.pushList) this.lists.set(change.pushList, [change.id, ...(this.lists.get(change.pushList) ?? [])]);
    if (change.removeSet) this.sets.get(change.removeSet)?.delete(change.id);
    if (change.addSet) {
      const set = this.sets.get(change.addSet.key) ?? new Map<string, number>();
      set.set(change.id, change.addSet.score); this.sets.set(change.addSet.key, set);
    }
    return true;
  }
  async zadd(key: string, score: number, value: string): Promise<number> { const set = this.sets.get(key) ?? new Map<string, number>(); const added = Number(!set.has(value)); set.set(value, score); this.sets.set(key, set); return added; }
  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    const lo = min === "-inf" ? -Infinity : Number(min); const hi = max === "+inf" ? Infinity : Number(max);
    return [...(this.sets.get(key) ?? new Map()).entries()].filter(([, score]) => score >= lo && score <= hi).sort((a, b) => a[1] - b[1]).map(([id]) => id);
  }
  async zrem(key: string, value: string): Promise<number> { return Number(this.sets.get(key)?.delete(value) ?? false); }
  async zcard(key: string): Promise<number> { return this.sets.get(key)?.size ?? 0; }
  async publish(channel: string, message: string): Promise<number> { this.bus.emit(channel, message); return this.bus.listenerCount(channel); }
  async subscribe(channel: string, listener: RedisListener): Promise<void> { this.bus.on(channel, listener); }
  async unsubscribe(channel: string, listener: RedisListener): Promise<void> { this.bus.off(channel, listener); }
}

// ioredis needs a dedicated subscriber connection. The injected client remains caller-owned.
export class IoredisTransport implements RedisTransport {
  private subscriber: any;
  private readonly listeners = new Map<string, Set<RedisListener>>();
  constructor(private readonly client: any) {

  }
  lpush(key: string, value: string): Promise<number> { return this.client.lpush(key, value); }
  lpop(key: string): Promise<string | null> { return this.client.lpop(key); }
  lrem(key: string, count: number, value: string): Promise<number> { return this.client.lrem(key, count, value); }
  lrange(key: string, start: number, stop: number): Promise<string[]> { return this.client.lrange(key, start, stop); }
  llen(key: string): Promise<number> { return this.client.llen(key); }
  rpoplpush(source: string, destination: string): Promise<string | null> { return this.client.rpoplpush(source, destination); }
  set(key: string, value: string): Promise<unknown> { return this.client.set(key, value); }
  get(key: string): Promise<string | null> { return this.client.get(key); }
  del(key: string): Promise<number> { return this.client.del(key); }
  hset(key: string, field: string | Record<string, string>, value?: string): Promise<number> { return typeof field === "string" ? this.client.hset(key, field, value) : this.client.hset(key, field); }
  hsetnx(key: string, field: string, value: string): Promise<number> { return this.client.hsetnx(key, field, value); }
  hgetall(key: string): Promise<Record<string, string>> { return this.client.hgetall(key); }
  async transitionJob(change: JobTransition): Promise<boolean> {
    const script = `
      local c = cjson.decode(ARGV[1])
      if redis.call('HGET', KEYS[1], 'state') ~= c.expectedState then return 0 end
      if c.expectedToken ~= cjson.null and redis.call('HGET', KEYS[1], 'lockToken') ~= c.expectedToken then return 0 end
      if c.expectedLease ~= cjson.null and redis.call('HGET', KEYS[1], 'lockAcquiredAt') ~= c.expectedLease then return 0 end
      if c.requireList ~= cjson.null then
        local found = false
        for _, value in ipairs(redis.call('LRANGE', c.requireList, 0, -1)) do if value == c.id then found = true; break end end
        if not found then return 0 end
      end
      for field, value in pairs(c.changes) do redis.call('HSET', KEYS[1], field, value) end
      if c.removeList ~= cjson.null then redis.call('LREM', c.removeList, 0, c.id) end
      if c.pushList ~= cjson.null then redis.call('LPUSH', c.pushList, c.id) end
      if c.removeSet ~= cjson.null then redis.call('ZREM', c.removeSet, c.id) end
      if c.addSet ~= cjson.null then redis.call('ZADD', c.addSet.key, c.addSet.score, c.id) end
      return 1`;
    const payload = { ...change, expectedToken: change.expectedToken ?? null, expectedLease: change.expectedLease ?? null, requireList: change.requireList ?? null,
      removeList: change.removeList ?? null, pushList: change.pushList ?? null, removeSet: change.removeSet ?? null,
      addSet: change.addSet ?? null };
    return (await this.client.eval(script, 1, change.jobKey, JSON.stringify(payload))) === 1;
  }
  zadd(key: string, score: number, value: string): Promise<number> { return this.client.zadd(key, score, value); }
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> { return this.client.zrangebyscore(key, min, max); }
  zrem(key: string, value: string): Promise<number> { return this.client.zrem(key, value); }
  zcard(key: string): Promise<number> { return this.client.zcard(key); }
  publish(channel: string, message: string): Promise<number> { return this.client.publish(channel, message); }
  async subscribe(channel: string, listener: RedisListener): Promise<void> {
    const listeners = this.listeners.get(channel) ?? new Set(); const first = listeners.size === 0;
    listeners.add(listener); this.listeners.set(channel, listeners);
    if (!this.subscriber) {
      this.subscriber = this.client.duplicate();
      this.subscriber.on("message", (channel: string, message: string) => {
        for (const fn of this.listeners.get(channel) ?? []) fn(message);
      });
    }
    if (first) await this.subscriber.subscribe(channel);
  }
  async unsubscribe(channel: string, listener: RedisListener): Promise<void> {
    const listeners = this.listeners.get(channel); listeners?.delete(listener);
    if (listeners?.size === 0) { this.listeners.delete(channel); await this.subscriber.unsubscribe(channel); }
    if (this.listeners.size === 0 && this.subscriber) { await this.subscriber.quit(); this.subscriber = undefined; }
  }
  async close(): Promise<void> { if (this.subscriber) await this.subscriber.quit(); this.subscriber = undefined; }
}

const defaultRedis = new MemoryRedis();
const clients = new WeakMap<object, IoredisTransport>();
export function resolveRedis(connection?: RedisTransport | "mock" | { duplicate(): unknown }): RedisTransport {
  if (!connection || connection === "mock") return defaultRedis;
  if ("publish" in connection && "subscribe" in connection && "hgetall" in connection && !("duplicate" in connection)) return connection as RedisTransport;
  let transport = clients.get(connection as object);
  if (!transport) { transport = new IoredisTransport(connection); clients.set(connection as object, transport); }
  return transport;
}
