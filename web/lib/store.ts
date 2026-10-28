// Message cache for the official mode. Meta does not offer an API to read
// past messages, so everything the MCP tools can read is what the webhook
// stored here (plus what we sent ourselves).

export type Direction = "in" | "out";

export type StoredMessage = {
  id: string;
  waId: string; // the customer's WhatsApp ID (phone digits)
  direction: Direction;
  type: string; // text, image, document, audio, video, sticker, location, reaction, button, interactive, template, ...
  text?: string;
  caption?: string;
  mediaId?: string;
  mime?: string;
  filename?: string;
  timestamp: number; // unix seconds
  status?: string; // outbound: sent | delivered | read | failed
  error?: string;
  replyTo?: string;
  reaction?: { messageId: string; emoji: string };
  source?: "api" | "business_app"; // business_app = echo from the WhatsApp Business app (coexistence)
  sender?: string; // personal mode: who wrote it (phone digits), for group messages
  senderName?: string;
};

export type Conversation = {
  waId: string;
  name?: string;
  lastAt: number;
  lastInboundAt?: number;
  windowOpen: boolean;
  windowClosesAt?: number;
  last?: StoredMessage;
};

/** The few Redis operations we need; implemented by Upstash and by MemoryKV for tests. */
export interface KV {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown>;
  zadd(key: string, member: { score: number; member: string }): Promise<unknown>;
  zrange<T = string[]>(key: string, start: number, stop: number, opts?: { rev?: boolean }): Promise<T>;
  zremrangebyrank(key: string, start: number, stop: number): Promise<unknown>;
  mget<T extends unknown[]>(...keys: string[]): Promise<T>;
}

const WINDOW_SECONDS = 24 * 60 * 60;
const PER_CHAT_CAP = 50_000;
const TTL_SECONDS = 3 * 365 * 24 * 60 * 60; // keep message bodies for 3 years

export class Store {
  /** prefix keeps the official ("") and personal ("p:") caches apart in one Redis. */
  constructor(
    private kv: KV,
    private p = "",
  ) {}

  async saveMessage(m: StoredMessage) {
    const existing = await this.kv.get<StoredMessage>(`${this.p}m:${m.id}`);
    // A status webhook can arrive before our own write; keep the later status.
    const merged = existing ? { ...m, status: existing.status ?? m.status, error: existing.error ?? m.error } : m;
    await this.kv.set(`${this.p}m:${m.id}`, merged, { ex: TTL_SECONDS });
    await this.kv.zadd(`${this.p}c:${m.waId}`, { score: m.timestamp, member: m.id });
    await this.kv.zremrangebyrank(`${this.p}c:${m.waId}`, 0, -(PER_CHAT_CAP + 1));
    // Older messages (history backfill) must never push a chat down the list.
    const lastAt = (await this.kv.get<number>(`${this.p}cl:${m.waId}`)) ?? 0;
    if (m.timestamp >= lastAt) {
      await this.kv.set(`${this.p}cl:${m.waId}`, m.timestamp);
      await this.kv.zadd(`${this.p}convs`, { score: m.timestamp, member: m.waId });
    }
    if (m.direction === "in") {
      const prev = (await this.kv.get<number>(`${this.p}in:${m.waId}`)) ?? 0;
      if (m.timestamp > prev) await this.kv.set(`${this.p}in:${m.waId}`, m.timestamp);
    }
  }

  /** The oldest message we hold for a chat, the anchor for asking WhatsApp for earlier ones. */
  async oldest(waId: string): Promise<StoredMessage | null> {
    const [id] = await this.kv.zrange<string[]>(`${this.p}c:${waId}`, 0, 0);
    return id ? this.getMessage(id) : null;
  }

  /** Every chat id we have seen, most recent first. */
  async allChats(): Promise<string[]> {
    return this.kv.zrange<string[]>(`${this.p}convs`, 0, -1, { rev: true });
  }

  async setName(waId: string, name: string) {
    if (name) await this.kv.set(`${this.p}n:${waId}`, name);
  }

  async getName(waId: string) {
    return (await this.kv.get<string>(`${this.p}n:${waId}`)) ?? undefined;
  }

  async updateStatus(id: string, status: string, error?: string) {
    const m = await this.kv.get<StoredMessage>(`${this.p}m:${id}`);
    const rank: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };
    if (!m) {
      // Remember the status so saveMessage can merge it when our write lands.
      await this.kv.set(`${this.p}m:${id}`, { id, status, error }, { ex: 3600 });
      return;
    }
    if ((rank[status] ?? 0) < (rank[m.status ?? ""] ?? 0) && status !== "failed") return;
    await this.kv.set(`${this.p}m:${id}`, { ...m, status, ...(error ? { error } : {}) }, { ex: TTL_SECONDS });
  }

  async getMessage(id: string) {
    const m = await this.kv.get<StoredMessage>(`${this.p}m:${id}`);
    return m?.waId ? m : null;
  }

  async messages(waId: string, limit = 30, before?: number): Promise<StoredMessage[]> {
    const ids = await this.kv.zrange<string[]>(`${this.p}c:${waId}`, 0, Math.max(limit * 3, 60) - 1, { rev: true });
    if (!ids.length) return [];
    const rows = await this.kv.mget<(StoredMessage | null)[]>(...ids.map((id) => `${this.p}m:${id}`));
    return rows
      .filter((m): m is StoredMessage => !!m && !!m.waId && (before === undefined || m.timestamp < before))
      .slice(0, limit)
      .reverse(); // oldest first, like a chat
  }

  async window(waId: string, now = Math.floor(Date.now() / 1000)) {
    const lastIn = (await this.kv.get<number>(`${this.p}in:${waId}`)) ?? undefined;
    const closesAt = lastIn ? lastIn + WINDOW_SECONDS : undefined;
    return { lastInboundAt: lastIn, windowOpen: !!closesAt && closesAt > now, windowClosesAt: closesAt };
  }

  async conversations(limit = 20, query?: string, now = Math.floor(Date.now() / 1000)): Promise<Conversation[]> {
    const scan = query ? 500 : limit;
    const waIds = await this.kv.zrange<string[]>(`${this.p}convs`, 0, scan - 1, { rev: true });
    const out: Conversation[] = [];
    const q = query?.toLowerCase().replace(/^\+/, "");
    for (const waId of waIds) {
      const name = (await this.kv.get<string>(`${this.p}n:${waId}`)) ?? undefined;
      if (q && !waId.includes(q) && !(name ?? "").toLowerCase().includes(q)) continue;
      const [last] = (await this.messages(waId, 1)).slice(-1);
      const w = await this.window(waId, now);
      out.push({ waId, name, lastAt: last?.timestamp ?? 0, last, ...w });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Substring search over the most recent messages of the most recent chats. */
  async search(query: string, limit = 20): Promise<StoredMessage[]> {
    const q = query.toLowerCase();
    const waIds = await this.kv.zrange<string[]>(`${this.p}convs`, 0, 99, { rev: true });
    const hits: StoredMessage[] = [];
    for (const waId of waIds) {
      for (const m of await this.messages(waId, 200)) {
        if (`${m.text ?? ""} ${m.caption ?? ""} ${m.filename ?? ""}`.toLowerCase().includes(q)) hits.push(m);
      }
    }
    return hits.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }
}

/** In-memory KV used by tests and local development without Redis. */
export class MemoryKV implements KV {
  private data = new Map<string, unknown>();
  private zsets = new Map<string, Map<string, number>>();

  async get<T>(key: string) {
    return (this.data.has(key) ? structuredClone(this.data.get(key)) : null) as T | null;
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
    return "OK";
  }
  async mget<T extends unknown[]>(...keys: string[]) {
    return (await Promise.all(keys.map((k) => this.get(k)))) as T;
  }
  private sorted(key: string) {
    return [...(this.zsets.get(key) ?? new Map()).entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  }
  async zadd(key: string, { score, member }: { score: number; member: string }) {
    if (!this.zsets.has(key)) this.zsets.set(key, new Map());
    this.zsets.get(key)!.set(member, score);
    return 1;
  }
  async zrange<T = string[]>(key: string, start: number, stop: number, opts?: { rev?: boolean }) {
    let s = this.sorted(key).map(([m]) => m);
    if (opts?.rev) s = s.reverse();
    const end = stop < 0 ? s.length + stop : stop;
    return s.slice(start, end + 1) as T;
  }
  async zremrangebyrank(key: string, start: number, stop: number) {
    const s = this.sorted(key);
    const end = stop < 0 ? s.length + stop : stop;
    for (const [m] of s.slice(start, end + 1)) this.zsets.get(key)!.delete(m);
    return 1;
  }
}
