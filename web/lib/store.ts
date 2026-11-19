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
  /** With nx the write happens only if the key is absent; the result is "OK" when it happened and null when it did not. */
  set(key: string, value: unknown, opts?: { ex?: number; nx?: boolean }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  zadd(key: string, member: { score: number; member: string }): Promise<unknown>;
  /** Rank range by default; with byScore, start/stop are scores (numbers, "-inf" or "+inf") and rev is not supported. */
  zrange<T = string[]>(key: string, start: number | string, stop: number | string, opts?: { rev?: boolean; byScore?: boolean }): Promise<T>;
  zremrangebyrank(key: string, start: number, stop: number): Promise<unknown>;
  mget<T extends unknown[]>(...keys: string[]): Promise<T>;
  /** One hash field; values are JSON-serialised by the client. */
  hget<T>(key: string, field: string): Promise<T | null>;
  hset(key: string, fields: Record<string, unknown>): Promise<unknown>;
  hgetall<T>(key: string): Promise<Record<string, T> | null>;
}

/** One row of the chat summary hash: enough to draw the chat list in one read. */
export type Summary = { waId: string; name?: string; lastAt: number; last?: StoredMessage; lastInboundAt?: number };

type OptOut = { at: number; reason: string; active: boolean };

const MGET_CHUNK = 500;
const WINDOW_SECONDS = 24 * 60 * 60;
const PER_CHAT_CAP = 50_000;
const TRIM_CHANCE = 0.05; // about one write in twenty trims a chat's message list
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
    // Trimming is cheap to skip: a chat only grows past the cap by a few messages before a later write trims it.
    if (Math.random() < TRIM_CHANCE) await this.kv.zremrangebyrank(`${this.p}c:${m.waId}`, 0, -(PER_CHAT_CAP + 1));

    // The summary row already holds the newest and last-inbound times, so the chat's own keys are read only when no row exists yet.
    const prev = await this.kv.hget<Summary>(`${this.p}sum`, m.waId);
    const lastAt = prev ? prev.lastAt : ((await this.kv.get<number>(`${this.p}cl:${m.waId}`)) ?? 0);
    // Older messages (history backfill) must never push a chat down the list.
    if (m.timestamp >= lastAt) {
      if (!prev) await this.kv.set(`${this.p}cl:${m.waId}`, m.timestamp);
      await this.kv.zadd(`${this.p}convs`, { score: m.timestamp, member: m.waId });
    }
    if (m.direction === "in") {
      const knownIn = prev ? (prev.lastInboundAt ?? 0) : ((await this.kv.get<number>(`${this.p}in:${m.waId}`)) ?? 0);
      if (m.timestamp > knownIn) await this.kv.set(`${this.p}in:${m.waId}`, m.timestamp);
    }
    await this.touchSummary(m, prev);
  }

  /** Keeps one summary row per chat in the "sum" hash, so the chat list is one read instead of several per chat. */
  private async touchSummary(m: StoredMessage, prev: Summary | null) {
    // A brand-new row takes its name from the name key, so it is not lost before the chat is named.
    const name = prev ? prev.name : (await this.kv.get<string>(`${this.p}n:${m.waId}`)) ?? undefined;
    const base: Summary = prev ?? { waId: m.waId, lastAt: 0 };
    const next: Summary = { ...base, waId: m.waId, name };
    if (m.timestamp >= base.lastAt) {
      next.lastAt = m.timestamp;
      next.last = m;
    }
    if (m.direction === "in" && m.timestamp > (base.lastInboundAt ?? 0)) next.lastInboundAt = m.timestamp;
    await this.kv.hset(`${this.p}sum`, { [m.waId]: next });
  }

  /** The oldest message we hold for a chat, the anchor for asking WhatsApp for earlier ones. */
  async oldest(waId: string): Promise<StoredMessage | null> {
    const [id] = await this.kv.zrange<string[]>(`${this.p}c:${waId}`, 0, 0);
    return id ? this.getMessage(id) : null;
  }

  /** Every chat id we have seen, most recent first. */
  async allChats(): Promise<string[]> {
    return (await this.kv.zrange<unknown[]>(`${this.p}convs`, 0, -1, { rev: true })).map(String);
  }

  async setName(waId: string, name: string) {
    if (!name) return;
    await this.kv.set(`${this.p}n:${waId}`, name);
    const prev = await this.kv.hget<Summary>(`${this.p}sum`, waId);
    if (prev && prev.name !== name) await this.kv.hset(`${this.p}sum`, { [waId]: { ...prev, name } });
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

  /** Messages by id in the same order; ids we do not hold (or hold only as a status stub) come back null. */
  async messagesByIds(ids: readonly string[]): Promise<(StoredMessage | null)[]> {
    const rows = await this.mgetAll<StoredMessage>(ids.map((id) => `${this.p}m:${id}`));
    return rows.map((m) => (m?.waId ? m : null));
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
    if (!query) {
      const fast = await this.summaryConversations(limit, now);
      if (fast) return fast;
    }
    const scan = query ? 500 : limit;
    // Upstash turns an all-digit member like "966500000001" back into a number: keep ids as strings.
    const waIds = (await this.kv.zrange<unknown[]>(`${this.p}convs`, 0, scan - 1, { rev: true })).map(String);
    if (!waIds.length) return [];
    // One round trip for every name, then each chat's last message and window in parallel:
    // a page of 200 chats used to cost 800+ Redis calls one after another.
    const names = await this.kv.mget<unknown[]>(...waIds.map((id) => `${this.p}n:${id}`));
    const q = query?.toLowerCase().replace(/^\+/, "");
    const picked = waIds
      .map((waId, i) => ({ waId, name: names[i] == null ? undefined : String(names[i]) }))
      .filter((c) => !q || c.waId.includes(q) || (c.name ?? "").toLowerCase().includes(q))
      .slice(0, limit);
    return Promise.all(
      picked.map(async ({ waId, name }) => {
        const [last, w] = await Promise.all([this.lastMessage(waId), this.window(waId, now)]);
        return { waId, name, lastAt: last?.timestamp ?? 0, last, ...w };
      }),
    );
  }

  /** The chat list from the summary hash: one read, sorted in memory. Null until the hash has been built (see scripts/build-summary.ts). */
  private async summaryConversations(limit: number, now: number): Promise<Conversation[] | null> {
    if (!(await this.kv.get<number>(`${this.p}sum:ok`))) return null;
    const rows = await this.kv.hgetall<Summary>(`${this.p}sum`);
    if (!rows) return [];
    return Object.values(rows)
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, limit)
      .map((r) => {
        const lastIn = r.lastInboundAt;
        const closesAt = lastIn ? lastIn + WINDOW_SECONDS : undefined;
        return {
          waId: r.waId,
          name: r.name,
          lastAt: r.lastAt,
          last: r.last,
          lastInboundAt: lastIn,
          windowClosesAt: closesAt,
          windowOpen: !!closesAt && closesAt > now,
        } as Conversation;
      });
  }

  /** Builds or replaces the summary hash from the stored messages. Run by hand, never inside a request. */
  async rebuildSummary(batch = 100): Promise<number> {
    const waIds = await this.allChats();
    let n = 0;
    // Chats are read in parallel groups, so a few thousand commands finish well inside one request.
    for (let i = 0; i < waIds.length; i += 25) {
      const group = waIds.slice(i, i + 25);
      const built = await Promise.all(
        group.map(async (waId) => {
          const [name, last, w] = await Promise.all([this.getName(waId), this.lastMessage(waId), this.window(waId)]);
          return [waId, { waId, name, lastAt: last?.timestamp ?? 0, last, lastInboundAt: w.lastInboundAt } as Summary] as const;
        }),
      );
      for (let j = 0; j < built.length; j += batch) {
        const rows = Object.fromEntries(built.slice(j, j + batch));
        await this.kv.hset(`${this.p}sum`, rows);
        n += Object.keys(rows).length;
      }
    }
    await this.kv.set(`${this.p}sum:ok`, 1);
    return n;
  }

  /** The newest message still cached, reading a handful of ids rather than a page. */
  private async lastMessage(waId: string): Promise<StoredMessage | undefined> {
    const ids = await this.kv.zrange<string[]>(`${this.p}c:${waId}`, 0, 4, { rev: true });
    if (!ids.length) return undefined;
    const rows = await this.kv.mget<(StoredMessage | null)[]>(...ids.map((id) => `${this.p}m:${id}`));
    return rows.find((m): m is StoredMessage => !!m && !!m.waId) ?? (await this.messages(waId, 1))[0];
  }

  /** How many chats are cached, up to max, in one call. */
  async countConversations(max = 200): Promise<number> {
    return (await this.kv.zrange<unknown[]>(`${this.p}convs`, 0, max - 1)).length;
  }

  /** Substring search over the most recent messages of the most recent chats. */
  async search(query: string, limit = 20): Promise<StoredMessage[]> {
    const q = query.toLowerCase();
    const waIds = (await this.kv.zrange<unknown[]>(`${this.p}convs`, 0, 99, { rev: true })).map(String);
    const hits: StoredMessage[] = [];
    for (const waId of waIds) {
      for (const m of await this.messages(waId, 200)) {
        if (`${m.text ?? ""} ${m.caption ?? ""} ${m.filename ?? ""}`.toLowerCase().includes(q)) hits.push(m);
      }
    }
    return hits.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  // -- Marketing campaigns ---------------------------------------------------
  // State the campaign preflight reads. Keys live under "mk:" and never touch
  // the message cache. Phones are normalised digits (966…); times are ms.

  private mkPhone(phone: string) {
    if (!/^\d{7,15}$/.test(phone)) throw new Error(`"${phone}" is not a normalised phone number (7 to 15 digits, no "+" or spaces)`);
    return phone;
  }

  private async mgetAll<T>(keys: string[]): Promise<(T | null)[]> {
    const out: (T | null)[] = [];
    for (let i = 0; i < keys.length; i += MGET_CHUNK) out.push(...(await this.kv.mget<(T | null)[]>(...keys.slice(i, i + MGET_CHUNK))));
    return out;
  }

  /** Marks a number as opted out (it replied "stop", blocked us, or asked by hand). */
  async recordOptOut(phone: string, reason: string, at = Date.now()) {
    const p = this.mkPhone(phone);
    await this.kv.set(`${this.p}mk:out:${p}`, { at, reason, active: true } satisfies OptOut);
    await this.kv.zadd(`${this.p}mk:outs`, { score: at, member: p });
  }

  /** Records that the person asked to receive messages again; the opt-out history stays. */
  async recordOptIn(phone: string, at = Date.now()) {
    const p = this.mkPhone(phone);
    const prev = await this.kv.get<OptOut>(`${this.p}mk:out:${p}`);
    if (prev) await this.kv.set(`${this.p}mk:out:${p}`, { ...prev, at, active: false });
  }

  /** Which of these numbers are currently opted out. */
  async optedOut(phones: readonly string[]): Promise<Set<string>> {
    const rows = await this.mgetAll<OptOut>(phones.map((p) => `${this.p}mk:out:${this.mkPhone(p)}`));
    return new Set(phones.filter((_, i) => rows[i]?.active));
  }

  /** Every number currently opted out, most recent first. */
  async optOuts(): Promise<{ phone: string; at: number; reason: string }[]> {
    const phones = (await this.kv.zrange<unknown[]>(`${this.p}mk:outs`, 0, -1, { rev: true })).map(String);
    const rows = await this.mgetAll<OptOut>(phones.map((p) => `${this.p}mk:out:${p}`));
    return phones.flatMap((phone, i) => (rows[i]?.active ? [{ phone, at: rows[i]!.at, reason: rows[i]!.reason }] : []));
  }

  /** Notes that a marketing message went to this number, for the cooldown and the 24-hour capacity count. */
  async recordMarketingSend(phone: string, at = Date.now()) {
    const p = this.mkPhone(phone);
    await this.kv.set(`${this.p}mk:last:${p}`, at);
    await this.kv.zadd(`${this.p}mk:recent`, { score: at, member: p });
  }

  /** When each of these numbers last received a marketing message; numbers never messaged are absent. */
  async lastMarketing(phones: readonly string[]): Promise<Map<string, number>> {
    const rows = await this.mgetAll<number>(phones.map((p) => `${this.p}mk:last:${this.mkPhone(p)}`));
    const out = new Map<string, number>();
    phones.forEach((p, i) => {
      const at = rows[i];
      if (typeof at === "number") out.set(p, at);
    });
    return out;
  }

  /** Small JSON documents for campaigns (state, recipients, outcomes), kept under "mk:". */
  async mkGet<T>(key: string): Promise<T | null> {
    return this.kv.get<T>(`${this.p}mk:${key}`);
  }

  async mkSet(key: string, value: unknown, opts?: { ex?: number }) {
    await this.kv.set(`${this.p}mk:${key}`, value, opts);
  }

  /** Takes a named lock that frees itself after ttlSeconds; false when another holder has it. */
  async mkLock(name: string, ttlSeconds: number): Promise<boolean> {
    return (await this.kv.set(`${this.p}mk:lock:${name}`, Date.now(), { ex: ttlSeconds, nx: true })) === "OK";
  }

  async mkUnlock(name: string) {
    await this.kv.del(`${this.p}mk:lock:${name}`);
  }

  /** Numbers that received a marketing message within the window (default 24 hours), for the messaging-limit count. */
  async recentMarketing(withinMs = 24 * 60 * 60 * 1000, now = Date.now()): Promise<Set<string>> {
    // Members come back as numbers when Upstash auto-deserialises digit strings.
    const phones = await this.kv.zrange<unknown[]>(`${this.p}mk:recent`, now - withinMs, "+inf", { byScore: true });
    return new Set(phones.map(String));
  }
}

/** In-memory KV used by tests and local development without Redis. */
export class MemoryKV implements KV {
  private data = new Map<string, unknown>();
  private expiresAt = new Map<string, number>();
  private zsets = new Map<string, Map<string, number>>();

  private live(key: string) {
    const exp = this.expiresAt.get(key);
    if (exp !== undefined && exp <= Date.now()) {
      this.data.delete(key);
      this.expiresAt.delete(key);
    }
    return this.data.has(key);
  }

  async get<T>(key: string) {
    return (this.live(key) ? structuredClone(this.data.get(key)) : null) as T | null;
  }
  async set(key: string, value: unknown, opts?: { ex?: number; nx?: boolean }) {
    if (opts?.nx && this.live(key)) return null;
    this.data.set(key, structuredClone(value));
    if (opts?.ex) this.expiresAt.set(key, Date.now() + opts.ex * 1000);
    else this.expiresAt.delete(key);
    return "OK";
  }
  private hashes = new Map<string, Map<string, unknown>>();

  async hget<T>(key: string, field: string) {
    const v = this.hashes.get(key)?.get(field);
    return (v === undefined ? null : structuredClone(v)) as T | null;
  }
  async hset(key: string, fields: Record<string, unknown>) {
    const h = this.hashes.get(key) ?? new Map<string, unknown>();
    for (const [f, v] of Object.entries(fields)) h.set(f, structuredClone(v));
    this.hashes.set(key, h);
    return Object.keys(fields).length;
  }
  async hgetall<T>(key: string) {
    const h = this.hashes.get(key);
    if (!h) return null;
    return Object.fromEntries([...h].map(([f, v]) => [f, structuredClone(v) as T])) as Record<string, T>;
  }
  async del(key: string) {
    this.data.delete(key);
    this.expiresAt.delete(key);
    return 1;
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
  async zrange<T = string[]>(key: string, start: number | string, stop: number | string, opts?: { rev?: boolean; byScore?: boolean }) {
    if (opts?.byScore) {
      const bound = (v: number | string) => (v === "-inf" ? -Infinity : v === "+inf" ? Infinity : Number(v));
      return this.sorted(key)
        .filter(([, score]) => score >= bound(start) && score <= bound(stop))
        .map(([m]) => m) as T;
    }
    let s = this.sorted(key).map(([m]) => m);
    if (opts?.rev) s = s.reverse();
    const from = Number(start);
    const to = Number(stop);
    const end = to < 0 ? s.length + to : to;
    return s.slice(from, end + 1) as T;
  }
  async zremrangebyrank(key: string, start: number, stop: number) {
    const s = this.sorted(key);
    const end = stop < 0 ? s.length + stop : stop;
    for (const [m] of s.slice(start, end + 1)) this.zsets.get(key)!.delete(m);
    return 1;
  }
}
