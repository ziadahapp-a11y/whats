// MCP tools for the official WhatsApp Cloud API mode.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { Graph, GraphError, normalizePhone } from "./graph";
import type { Store, StoredMessage } from "./store";

/** canSend: false registers the read tools only, for read-only keys. */
type Deps = { graph: Graph; store: Store; canSend?: boolean };

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SEND = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const recipient = z
  .string()
  .describe("recipient's WhatsApp number with country code, digits only (e.g. 966501234567); `+`, spaces and dashes are stripped");

const WINDOW_HINT =
  "WhatsApp only allows free-form messages within 24 hours of the customer's last message. Outside that window, use send_template with an approved template.";

function describeError(e: unknown): string {
  if (e instanceof GraphError) {
    if (e.code === 131047 || e.code === 131026) return `${e.message}. ${WINDOW_HINT}`;
    if (e.code === 190) return `${e.message}. The access token is invalid or expired: generate a new System User token in Meta Business Settings and update WHATSAPP_ACCESS_TOKEN.`;
    return `WhatsApp API error${e.code ? ` ${e.code}` : ""}: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

function line(m: StoredMessage, names: Record<string, string | undefined> = {}): string {
  const when = new Date(m.timestamp * 1000).toISOString().replace("T", " ").slice(0, 16);
  const who = m.direction === "out" ? (m.source === "business_app" ? "You (app)" : "You") : names[m.waId] || `+${m.waId}`;
  const body = m.text ?? m.caption ?? "";
  const media = m.mediaId ? ` [${m.type}${m.filename ? `: ${m.filename}` : ""}, media_id=${m.mediaId}]` : "";
  const status = m.direction === "out" && m.status ? ` (${m.status}${m.error ? `: ${m.error}` : ""})` : "";
  const reply = m.replyTo ? ` ↩ ${m.replyTo}` : "";
  return `[${when} UTC] ${who}: ${body}${media}${status}${reply}  {id: ${m.id}}`;
}

export function registerTools(server: McpServer, { graph, store, canSend = true }: Deps) {
  // Wraps a send so the outgoing message lands in the cache like webhook-received ones.
  async function recordOutgoing(to: string, res: { messageId: string; waId?: string }, partial: Partial<StoredMessage>) {
    const waId = res.waId ?? normalizePhone(to);
    await store.saveMessage({
      id: res.messageId,
      waId,
      direction: "out",
      type: partial.type ?? "text",
      timestamp: Math.floor(Date.now() / 1000),
      status: "sent",
      source: "api",
      ...partial,
    });
    return waId;
  }

  async function guardWindow(to: string) {
    const w = await store.window(normalizePhone(to));
    if (w.lastInboundAt && !w.windowOpen) {
      return `The 24-hour window with +${normalizePhone(to)} closed at ${new Date(w.windowClosesAt! * 1000).toISOString()}. ${WINDOW_HINT}`;
    }
    return null;
  }

  // ---- read --------------------------------------------------------------

  server.registerTool(
    "list_conversations",
    {
      title: "List conversations",
      description:
        "List customers who have messaged this WhatsApp Business number (from the webhook cache), most recent first, with their name, last message and whether the 24-hour reply window is open. Read-only. Use list_messages to read one conversation. Returns a JSON array of {waId, name, lastAt, windowOpen, windowClosesAt, last}.",
      inputSchema: z.object({
        query: z.string().optional().describe("filter by name or phone digits"),
        limit: z.number().int().min(1).max(100).default(20).describe("max conversations (default 20)"),
      }),
      annotations: READ,
    },
    async ({ query, limit }) => json(await store.conversations(limit, query)),
  );

  server.registerTool(
    "list_messages",
    {
      title: "Read a conversation",
      description:
        "Read the cached messages exchanged with one customer, oldest first. Read-only. Only messages received after the webhook was connected (plus ones sent through this server or echoed from the Business app) exist; Meta offers no API to fetch older history. Returns one formatted line per message including its id for replies and reactions.",
      inputSchema: z.object({
        contact: recipient,
        limit: z.number().int().min(1).max(200).default(30).describe("max messages (default 30)"),
        before: z.string().optional().describe("ISO-8601 timestamp; only messages before it (for paging back)"),
      }),
      annotations: READ,
    },
    async ({ contact, limit, before }) => {
      const waId = normalizePhone(contact);
      const msgs = await store.messages(waId, limit, before ? Math.floor(Date.parse(before) / 1000) : undefined);
      if (!msgs.length) return text(`No cached messages with +${waId}.`);
      const [conv] = await store.conversations(1, waId);
      const w = await store.window(waId);
      const header = `Conversation with ${conv?.name ?? ""} +${waId} — reply window ${w.windowOpen ? `open until ${new Date(w.windowClosesAt! * 1000).toISOString()}` : "closed (templates only)"}`;
      return text([header, ...msgs.map((m) => line(m, { [waId]: conv?.name }))].join("\n"));
    },
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description:
        "Case-insensitive substring search over message text, captions and file names in the 100 most recent conversations. Read-only. Returns matching messages newest first, one formatted line each.",
      inputSchema: z.object({
        query: z.string().min(1).describe("text to look for"),
        limit: z.number().int().min(1).max(100).default(20).describe("max results (default 20)"),
      }),
      annotations: READ,
    },
    async ({ query, limit }) => {
      const hits = await store.search(query, limit);
      return text(hits.length ? hits.map((m) => line(m)).join("\n") : `No messages contain "${query}".`);
    },
  );

  server.registerTool(
    "get_media",
    {
      title: "Get media",
      description:
        "Download an image, sticker, audio, video or document a customer sent, by its media_id (shown in list_messages). Images up to 5 MB come back as viewable image content; other files return their metadata. Meta keeps inbound media for a limited time, so old IDs may fail.",
      inputSchema: z.object({ media_id: z.string().describe("media_id from list_messages") }),
      annotations: { ...READ, openWorldHint: true },
    },
    async ({ media_id }) => {
      try {
        const { meta, bytes } = await graph.downloadMedia(media_id);
        if (bytes && meta.mime_type.startsWith("image/")) {
          return {
            content: [
              { type: "image" as const, data: Buffer.from(bytes).toString("base64"), mimeType: meta.mime_type.split(";")[0] },
              { type: "text" as const, text: `${meta.mime_type}, ${meta.file_size} bytes` },
            ],
          };
        }
        return json({ mime_type: meta.mime_type, file_size: meta.file_size, sha256: meta.sha256, note: bytes ? "not an image; content not inlined" : "larger than 5 MB; not downloaded" });
      } catch (e) {
        return fail(describeError(e));
      }
    },
  );

  server.registerTool(
    "list_templates",
    {
      title: "List message templates",
      description:
        "List this WhatsApp Business Account's message templates with their status, language, category and components. Read-only. Use before send_template to find the exact name, language code and number of {{n}} parameters. Templates are created and approved in Meta's WhatsApp Manager.",
      inputSchema: z.object({
        status: z.enum(["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED"]).optional().describe("filter by status (default: all)"),
      }),
      annotations: { ...READ, openWorldHint: true },
    },
    async ({ status }) => {
      try {
        return json((await graph.listTemplates(status)).data);
      } catch (e) {
        return fail(describeError(e));
      }
    },
  );

  server.registerTool(
    "get_number_status",
    {
      title: "Number status",
      description:
        "Show this business number's verified name, quality rating, messaging limit tier and business profile, plus how many conversations are cached. Read-only. Call first when sends fail, to check the number and token are healthy.",
      inputSchema: z.object({}),
      annotations: { ...READ, openWorldHint: true },
    },
    async () => {
      try {
        const [phone, profile, convs] = await Promise.all([graph.phoneInfo(), graph.businessProfile(), store.countConversations(100)]);
        return json({ phone, profile: (profile as any)?.data?.[0] ?? profile, cachedConversations: convs });
      } catch (e) {
        return fail(describeError(e));
      }
    },
  );

  // ---- send --------------------------------------------------------------

  if (!canSend) return;

  server.registerTool(
    "send_text",
    {
      title: "Send text message",
      description:
        "Send a text message from the business number to a customer. Only works inside the 24-hour window after their last message; outside it use send_template. Pass reply_to to quote one of their messages. The customer receives it immediately and it cannot be unsent. Returns the new message id.",
      inputSchema: z.object({
        to: recipient,
        body: z.string().min(1).max(4096).describe("message text, up to 4096 characters; WhatsApp formatting like *bold* works"),
        reply_to: z.string().optional().describe("id of the message to quote (from list_messages)"),
        preview_url: z.boolean().default(false).describe("show a link preview for the first URL (default false)"),
      }),
      annotations: SEND,
    },
    async ({ to, body, reply_to, preview_url }) => {
      try {
        const closed = await guardWindow(to);
        if (closed) return fail(closed);
        const res = await graph.sendMessage(to, { type: "text", text: { body, preview_url } }, reply_to);
        await recordOutgoing(to, res, { type: "text", text: body, replyTo: reply_to });
        return json({ sent: true, message_id: res.messageId });
      } catch (e) {
        return fail(describeError(e));
      }
    },
  );

  server.registerTool(
    "send_media",
    {
      title: "Send media",
      description:
        "Send an image, video, audio file or document by public HTTPS URL (Meta downloads it). Same 24-hour window rule as send_text. The customer receives it immediately. Returns the new message id.",
      inputSchema: z.object({
        to: recipient,
        type: z.enum(["image", "video", "audio", "document"]).describe("kind of media"),
        url: z.string().url().describe("public https URL of the file"),
        caption: z.string().max(1024).optional().describe("caption (not for audio)"),
        filename: z.string().optional().describe("file name shown to the customer (documents only)"),
        reply_to: z.string().optional().describe("id of the message to quote"),
      }),
      annotations: SEND,
    },
    async ({ to, type, url, caption, filename, reply_to }) => {
      try {
        const closed = await guardWindow(to);
        if (closed) return fail(closed);
        const media: Record<string, string> = { link: url };
        if (caption && type !== "audio") media.caption = caption;
        if (filename && type === "document") media.filename = filename;
        const res = await graph.sendMessage(to, { type, [type]: media }, reply_to);
        await recordOutgoing(to, res, { type, caption, filename, text: `[${type}] ${url}`, replyTo: reply_to });
        return json({ sent: true, message_id: res.messageId });
      } catch (e) {
        return fail(describeError(e));
      }
    },
  );

  server.registerTool(
    "send_template",
    {
      title: "Send template message",
      description:
        "Send an approved message template; the only way to start a conversation or write after the 24-hour window. Meta charges per template message by category and country. Use list_templates for the name, language and parameter count. The customer receives it immediately. Returns the new message id.",
      inputSchema: z.object({
        to: recipient,
        name: z.string().describe("template name exactly as in list_templates"),
        language: z.string().default("ar").describe("template language code, e.g. ar, en_US (default ar)"),
        body_params: z.array(z.string()).default([]).describe("values for {{1}}, {{2}}, … in the template body, in order"),
        header_params: z.array(z.string()).default([]).describe("values for text-header variables, if the template has any"),
        components: z.array(z.record(z.string(), z.unknown())).optional().describe("advanced: raw Cloud API components array; overrides body_params/header_params"),
      }),
      annotations: SEND,
    },
    async ({ to, name, language, body_params, header_params, components }) => {
      try {
        const comps =
          components ??
          [
            ...(header_params.length ? [{ type: "header", parameters: header_params.map((t) => ({ type: "text", text: t })) }] : []),
            ...(body_params.length ? [{ type: "body", parameters: body_params.map((t) => ({ type: "text", text: t })) }] : []),
          ];
        const res = await graph.sendMessage(to, { type: "template", template: { name, language: { code: language }, ...(comps.length ? { components: comps } : {}) } });
        await recordOutgoing(to, res, { type: "template", text: `[template ${name}] ${body_params.join(" | ")}`.trim() });
        return json({ sent: true, message_id: res.messageId });
      } catch (e) {
        return fail(describeError(e));
      }
    },
  );

  server.registerTool(
    "send_buttons",
    {
      title: "Send reply buttons",
      description:
        "Send a message with up to three tap-to-reply buttons; the customer's choice arrives as a normal message. Same 24-hour window rule as send_text. Returns the new message id.",
      inputSchema: z.object({
        to: recipient,
        body: z.string().min(1).max(1024).describe("message text above the buttons"),
        buttons: z.array(z.string().min(1).max(20)).min(1).max(3).describe("1–3 button labels, up to 20 characters each"),
        footer: z.string().max(60).optional().describe("small grey text under the message"),
      }),
      annotations: SEND,
    },
    async ({ to, body, buttons, footer }) => {
      try {
        const closed = await guardWindow(to);
        if (closed) return fail(closed);
        const interactive = {
          type: "button",
          body: { text: body },
          ...(footer ? { footer: { text: footer } } : {}),
          action: { buttons: buttons.map((title, i) => ({ type: "reply", reply: { id: `b${i + 1}`, title } })) },
        };
        const res = await graph.sendMessage(to, { type: "interactive", interactive });
        await recordOutgoing(to, res, { type: "interactive", text: `${body} [${buttons.join(" / ")}]` });
        return json({ sent: true, message_id: res.messageId });
      } catch (e) {
        return fail(describeError(e));
      }
    },
  );

  server.registerTool(
    "send_reaction",
    {
      title: "React to a message",
      description:
        "React to a customer's message with an emoji, or pass an empty emoji to remove your reaction. Reversible by reacting again. Returns the reaction's message id.",
      inputSchema: z.object({
        to: recipient,
        message_id: z.string().describe("id of the message to react to (from list_messages)"),
        emoji: z.string().max(8).describe("one emoji, or empty string to remove"),
      }),
      annotations: { ...SEND, idempotentHint: true },
    },
    async ({ to, message_id, emoji }) => {
      try {
        const res = await graph.sendMessage(to, { type: "reaction", reaction: { message_id, emoji } });
        await recordOutgoing(to, res, { type: "reaction", reaction: { messageId: message_id, emoji }, text: emoji ? `reacted ${emoji}` : "removed a reaction" });
        return json({ sent: true, message_id: res.messageId });
      } catch (e) {
        return fail(describeError(e));
      }
    },
  );

  server.registerTool(
    "mark_read",
    {
      title: "Mark as read",
      description:
        "Mark a customer's message (and everything before it) as read, so they see blue ticks; optionally show a typing indicator for up to 25 seconds while you prepare a reply. Not reversible. Returns {success}.",
      inputSchema: z.object({
        message_id: z.string().describe("id of the latest inbound message (from list_messages)"),
        typing: z.boolean().default(false).describe("also show \"typing…\" to the customer (default false)"),
      }),
      annotations: { ...SEND, idempotentHint: true },
    },
    async ({ message_id, typing }) => {
      try {
        await graph.markRead(message_id, typing);
        return json({ success: true });
      } catch (e) {
        return fail(describeError(e));
      }
    },
  );
}

export const TOOL_NAMES = [
  "list_conversations",
  "list_messages",
  "search_messages",
  "get_media",
  "list_templates",
  "get_number_status",
  "send_text",
  "send_media",
  "send_template",
  "send_buttons",
  "send_reaction",
  "mark_read",
];
