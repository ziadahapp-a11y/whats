// MCP tools for the personal (linked-device) mode on Vercel.
// Reads come from the Redis cache, refreshed by a short connection when stale;
// sends open a connection, deliver, and disconnect. One deployment can hold
// several numbers: every tool takes an optional `account`, and a key can be
// limited to some numbers and to read-only.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AccountDeps } from "../runtime";
import type { RawKV } from "./auth";
import { isPaired } from "./auth";
import { MAIN } from "./accounts";
import { markRead, remember, sendReaction, sendText } from "./ops";
import { lastSync, toJid, withWhatsApp } from "./session";
import { syncAccount } from "../flows/sync";
import type { StoredMessage } from "../store";

export type Entry = { id: string; label: string; deps: AccountDeps };
export type PersonalCtx = {
  base: RawKV;
  /** the numbers this key may use */
  accounts: Entry[];
  /** false for read-only keys: the send tools are not even offered */
  canSend: boolean;
};

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const SEND = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const chatArg = z
  .string()
  .describe("chat: a phone number with country code (digits; `+` and spaces are ignored), a `<digits>@s.whatsapp.net` JID, or a group JID ending in `@g.us` (see list_chats)");

const accountArg = z.string().optional().describe("which WhatsApp number to use: an id from list_accounts. Optional when only one number is available");

const STALE_SECONDS = 120;

function line(m: StoredMessage, chatName?: string) {
  const when = new Date(m.timestamp * 1000).toISOString().replace("T", " ").slice(0, 16);
  const who = m.direction === "out" ? "You" : m.senderName || (m.sender ? `+${m.sender}` : chatName || m.waId);
  const body = m.text ?? m.caption ?? "";
  const media = m.type && ["image", "video", "audio", "document", "sticker"].includes(m.type) ? ` [${m.type}${m.filename ? `: ${m.filename}` : ""}]` : "";
  const reply = m.replyTo ? ` ↩ ${m.replyTo}` : "";
  return `[${when} UTC] ${who}: ${body}${media}${reply}  {id: ${m.id}}`;
}

export function registerPersonalTools(server: McpServer, ctx: PersonalCtx) {
  const { base, accounts, canSend } = ctx;
  const many = accounts.length > 1;

  function pick(account: string | undefined, write: boolean): { a: Entry } | { error: string } {
    if (!accounts.length) return { error: "This key has no WhatsApp numbers assigned." };
    const names = accounts.map((x) => `${x.id} (${x.label})`).join(", ");
    if (account) {
      const q = account.trim().toLowerCase();
      const hit = accounts.find((x) => x.id === q || x.label.toLowerCase() === q);
      return hit ? { a: hit } : { error: `Unknown or not allowed account "${account}". Available: ${names}` };
    }
    if (accounts.length === 1) return { a: accounts[0] };
    if (write) return { error: `Several numbers are available (${names}). Say which one with the \`account\` argument.` };
    return { a: accounts.find((x) => x.id === MAIN) ?? accounts[0] };
  }

  /** Syncs first when the cache is older than STALE_SECONDS (or when forced). */
  async function refresh(a: Entry, force = false): Promise<string> {
    const last = await lastSync(a.deps.raw);
    const age = last ? Math.floor(Date.now() / 1000) - last : Infinity;
    if (!force && age < STALE_SECONDS) return "";
    try {
      const { ingested } = await syncAccount(base, a.deps, { maxMs: 60_000 });
      return `(synced: ${ingested} new)`;
    } catch (e) {
      return `(could not sync, showing cached data: ${errText(e)})`;
    }
  }

  const header = (a: Entry) => (many ? `Number: ${a.label} (${a.id})\n` : "");

  server.registerTool(
    "list_accounts",
    {
      title: "List WhatsApp numbers",
      description: "List the WhatsApp numbers this connection can use, with their ids, whether each is linked, and the phone number. Read-only; does not connect. Pass an id as `account` to the other tools when there is more than one.",
      inputSchema: z.object({}),
      annotations: { ...READ, openWorldHint: false },
    },
    async () => {
      const rows = await Promise.all(accounts.map(async (x) => ({ id: x.id, label: x.label, ...(await isPaired(x.deps.raw)), canSend })));
      return json(rows.map(({ me, name, ...r }) => ({ ...r, number: me ? `+${me.split(":")[0].split("@")[0]}` : undefined, profileName: name })));
    },
  );

  server.registerTool(
    "get_status",
    {
      title: "Link status",
      description:
        "Report whether WhatsApp is linked, which number, when messages were last synced and how many chats are cached. Read-only; does not connect. Call first when other tools fail.",
      inputSchema: z.object({ account: accountArg }),
      annotations: { ...READ, openWorldHint: false },
    },
    async ({ account }) => {
      const picked = account || accounts.length <= 1 ? [pick(account, false)] : accounts.map((a) => ({ a }));
      const out = [];
      for (const p of picked) {
        if ("error" in p) return fail(p.error);
        const { a } = p;
        const info = await isPaired(a.deps.raw);
        const last = await lastSync(a.deps.raw);
        const chats = await a.deps.store.countConversations(200);
        out.push({ account: a.id, label: a.label, ...info, lastSync: last ? new Date(last * 1000).toISOString() : null, cachedChats: chats, hint: info.paired ? undefined : "Open /personal on this deployment to link this number." });
      }
      return json(out.length === 1 ? out[0] : out);
    },
  );

  server.registerTool(
    "sync",
    {
      title: "Sync now",
      description:
        "Connect to WhatsApp briefly to collect every message that arrived since the last sync, then disconnect (this also runs your automation flows). Takes about 5–20 seconds. Read tools already sync automatically when the cache is older than 2 minutes. Returns how many messages were added.",
      inputSchema: z.object({ account: accountArg }),
      annotations: { ...READ, idempotentHint: false },
    },
    async ({ account }) => {
      const p = pick(account, false);
      if ("error" in p) return fail(p.error);
      try {
        const { ingested } = await syncAccount(base, p.a.deps, { maxMs: 60_000 });
        return json({ account: p.a.id, synced: true, newMessages: ingested });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "list_chats",
    {
      title: "List chats",
      description:
        "List cached chats (people and groups), most recent first, with name and last message. Syncs first when the cache is older than 2 minutes. Read-only. Use list_messages to read one chat. Returns JSON [{waId (the chat JID), name, lastAt, last}].",
      inputSchema: z.object({
        account: accountArg,
        query: z.string().optional().describe("filter by name or number"),
        limit: z.number().int().min(1).max(100).default(20).describe("max chats (default 20)"),
        fresh: z.boolean().default(true).describe("sync first if stale (default true); false answers instantly from cache"),
      }),
      annotations: READ,
    },
    async ({ account, query, limit, fresh }) => {
      const p = pick(account, false);
      if ("error" in p) return fail(p.error);
      const note = fresh ? await refresh(p.a) : "";
      const chats = (await p.a.deps.store.conversations(limit, query)).map(({ windowOpen, windowClosesAt, lastInboundAt, ...c }) => c);
      return text(`${header(p.a)}${note}\n${JSON.stringify(chats, null, 2)}`.trim());
    },
  );

  server.registerTool(
    "list_messages",
    {
      title: "Read a chat",
      description:
        "Read the cached messages of one chat, oldest first. Syncs first when the cache is older than 2 minutes. History older than the moment you linked is only present if WhatsApp sent it during linking. Read-only. Returns one line per message with its id for replies and reactions.",
      inputSchema: z.object({
        account: accountArg,
        chat: chatArg,
        limit: z.number().int().min(1).max(200).default(40).describe("max messages (default 40)"),
        before: z.string().optional().describe("ISO-8601 timestamp; only messages before it"),
        fresh: z.boolean().default(true).describe("sync first if stale (default true)"),
      }),
      annotations: READ,
    },
    async ({ account, chat, limit, before, fresh }) => {
      const p = pick(account, false);
      if ("error" in p) return fail(p.error);
      try {
        const jid = toJid(chat);
        const note = fresh ? await refresh(p.a) : "";
        const { store } = p.a.deps;
        const msgs = await store.messages(jid, limit, before ? Math.floor(Date.parse(before) / 1000) : undefined);
        const [conv] = await store.conversations(1, jid.split("@")[0]);
        if (!msgs.length) return text(`${header(p.a)}${note} No cached messages in ${jid}.`.trim());
        return text([header(p.a).trim(), note, `Chat: ${conv?.name ?? jid}`, ...msgs.map((m) => line(m, conv?.name))].filter(Boolean).join("\n"));
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description: "Case-insensitive text search across the 100 most recent cached chats of one number. Syncs first when stale. Read-only. Returns matching messages newest first.",
      inputSchema: z.object({
        account: accountArg,
        query: z.string().min(1).describe("text to look for"),
        limit: z.number().int().min(1).max(100).default(20).describe("max results (default 20)"),
      }),
      annotations: READ,
    },
    async ({ account, query, limit }) => {
      const p = pick(account, false);
      if ("error" in p) return fail(p.error);
      const note = await refresh(p.a);
      const hits = await p.a.deps.store.search(query, limit);
      return text([header(p.a).trim(), note, ...(hits.length ? hits.map((m) => `${m.waId} ${line(m)}`) : [`No messages contain "${query}".`])].filter(Boolean).join("\n"));
    },
  );

  server.registerTool(
    "list_groups",
    {
      title: "List groups",
      description: "Fetch every group the number is in from WhatsApp, with JID, name and member count (connects briefly). Read-only. Use the JID with list_messages or send_message.",
      inputSchema: z.object({ account: accountArg }),
      annotations: READ,
    },
    async ({ account }) => {
      const p = pick(account, false);
      if ("error" in p) return fail(p.error);
      try {
        const { result } = await withWhatsApp(p.a.deps, (sock) => sock.groupFetchAllParticipating(), { drain: false });
        const groups = Object.values(result).map((g: any) => ({ jid: g.id, name: g.subject, members: g.participants?.length ?? 0, announce: !!g.announce }));
        for (const gr of groups) if (gr.name) await p.a.deps.store.setName(gr.jid, gr.name);
        return json(groups.sort((a, b) => a.name.localeCompare(b.name)));
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "check_numbers",
    {
      title: "Check numbers",
      description: "Check which phone numbers have WhatsApp (connects briefly; the people are not notified). Read-only. Returns [{number, exists, jid}].",
      inputSchema: z.object({ account: accountArg, numbers: z.array(z.string()).min(1).max(50).describe("phone numbers with country code") }),
      annotations: READ,
    },
    async ({ account, numbers }) => {
      const p = pick(account, false);
      if ("error" in p) return fail(p.error);
      try {
        const digits = numbers.map((n) => n.replace(/\D/g, ""));
        const { result } = await withWhatsApp(p.a.deps, (sock) => sock.onWhatsApp(...digits), { drain: false });
        return json(digits.map((d) => {
          const hit = (result ?? []).find((r: any) => r.jid?.startsWith(d));
          return { number: d, exists: !!hit?.exists, jid: hit?.jid };
        }));
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  if (!canSend) return; // read-only key: nothing below is offered

  server.registerTool(
    "send_message",
    {
      title: "Send message",
      description:
        "Send a WhatsApp text from the user's own number to a person or group; it is delivered immediately and appears in the phone's chat. Pass reply_to to quote a message. Confirm recipient and wording with the user first. Returns the message id.",
      inputSchema: z.object({
        account: accountArg,
        to: chatArg,
        text: z.string().min(1).max(4096).describe("message text"),
        reply_to: z.string().optional().describe("id of the message to quote (from list_messages)"),
      }),
      annotations: SEND,
    },
    async ({ account, to, text: body, reply_to }) => {
      const p = pick(account, true);
      if ("error" in p) return fail(p.error);
      try {
        const jid = toJid(to);
        const { result } = await withWhatsApp(p.a.deps, (sock) => sendText(sock, p.a.deps.store, jid, body, reply_to), { drain: false });
        return json({ account: p.a.id, sent: true, message_id: result });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "send_media",
    {
      title: "Send media",
      description:
        "Send an image, video, audio or document from a public HTTPS URL to a person or group. Delivered immediately. Confirm with the user first. Returns the message id.",
      inputSchema: z.object({
        account: accountArg,
        to: chatArg,
        type: z.enum(["image", "video", "audio", "document"]).describe("kind of media"),
        url: z.string().url().describe("public https URL of the file"),
        caption: z.string().max(1024).optional().describe("caption (not for audio)"),
        filename: z.string().optional().describe("file name (documents)"),
        mimetype: z.string().optional().describe("MIME type for documents, e.g. application/pdf (default application/octet-stream)"),
      }),
      annotations: SEND,
    },
    async ({ account, to, type, url, caption, filename, mimetype }) => {
      const p = pick(account, true);
      if ("error" in p) return fail(p.error);
      try {
        const jid = toJid(to);
        const content: any =
          type === "document"
            ? { document: { url }, mimetype: mimetype ?? "application/octet-stream", fileName: filename ?? url.split("/").pop(), caption }
            : type === "audio"
              ? { audio: { url }, mimetype: mimetype ?? "audio/mpeg" }
              : { [type]: { url }, caption };
        const { result } = await withWhatsApp(p.a.deps, (sock) => sock.sendMessage(jid, content), { drain: false });
        await remember(p.a.deps.store, result, jid, { type, caption, filename, text: `[${type}] ${url}` });
        return json({ account: p.a.id, sent: true, message_id: result?.key?.id });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "send_reaction",
    {
      title: "React to a message",
      description: "React to a message with an emoji, or an empty string to remove your reaction. Reversible. Returns the reaction's id.",
      inputSchema: z.object({
        account: accountArg,
        chat: chatArg,
        message_id: z.string().describe("id of the message (from list_messages)"),
        emoji: z.string().max(8).describe("one emoji, or empty to remove"),
      }),
      annotations: { ...SEND, idempotentHint: true },
    },
    async ({ account, chat, message_id, emoji }) => {
      const p = pick(account, true);
      if ("error" in p) return fail(p.error);
      try {
        const jid = toJid(chat);
        const { result } = await withWhatsApp(p.a.deps, (sock) => sendReaction(sock, p.a.deps.store, jid, message_id, emoji), { drain: false });
        return json({ account: p.a.id, sent: true, message_id: result });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "mark_read",
    {
      title: "Mark chat as read",
      description: "Mark the latest received messages in a chat as read, so senders see blue ticks (if read receipts are on). Not reversible. Returns how many were marked.",
      inputSchema: z.object({ account: accountArg, chat: chatArg, count: z.number().int().min(1).max(50).default(10).describe("how many recent incoming messages (default 10)") }),
      annotations: { ...SEND, idempotentHint: true },
    },
    async ({ account, chat, count }) => {
      const p = pick(account, true);
      if ("error" in p) return fail(p.error);
      try {
        const jid = toJid(chat);
        const incoming = (await p.a.deps.store.messages(jid, 100)).filter((m) => m.direction === "in").slice(-count);
        if (!incoming.length) return json({ marked: 0 });
        await withWhatsApp(p.a.deps, (sock) => markRead(sock, jid, incoming), { drain: false });
        return json({ account: p.a.id, marked: incoming.length });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );
}

export const READ_TOOL_NAMES = ["list_accounts", "get_status", "sync", "list_chats", "list_messages", "search_messages", "list_groups", "check_numbers"];
export const SEND_TOOL_NAMES = ["send_message", "send_media", "send_reaction", "mark_read"];
export const PERSONAL_TOOL_NAMES = [...READ_TOOL_NAMES, ...SEND_TOOL_NAMES];
