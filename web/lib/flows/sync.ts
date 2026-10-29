// Glue between the engine and the two channels: a personal-number sync that
// runs flows while the connection is open, and the official webhook runner.

import type { WASocket } from "baileys";
import type { AccountDeps } from "../runtime";
import type { RawKV } from "../wa/auth";
import { markRead, meDigits, sendReaction, sendText } from "../wa/ops";
import { toJid, withWhatsApp } from "../wa/session";
import { agentFromEnv, aiFromEnv } from "./ai";
import { listConnectors } from "../connectors";
import { connectMcp } from "../mcpclient";
import { fileUrl, loadFile, publicBase, saveFile } from "../files";
import { knowledgeContext } from "../kb/store";
import { catchUpUnanswered, runFlows, type Channel, type EngineDeps } from "./engine";
import { flowsFor, isPaused } from "./storage";
import { ctaPayload, linkButton, plainLinks } from "./links";
import { sendFollowups } from "./followup";
import { meetings, sendMeetingReminders } from "./meetings";
import type { StoredMessage } from "../store";

const num = (v: string | undefined, fallback: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

export const engineLimits = (env: Record<string, string | undefined> = process.env) => ({
  aiDailyCap: num(env.AI_MAX_PER_DAY, 300),
  chatHourlyCap: num(env.FLOW_CHAT_HOURLY_CAP, 10),
});

export function personalChannel(sock: WASocket, a: AccountDeps): Channel {
  return {
    account: a.id,
    kind: "personal",
    me: meDigits(sock),
    sendText: (chat, text, replyTo) => sendText(sock, a.store, chat, text, replyTo),
    react: async (chat, msg, emoji) => void (await sendReaction(sock, a.store, chat, msg.id, emoji)),
    markRead: async (chat, msg) => void (await markRead(sock, chat, [msg])),
    resolveTarget: toJid,
  };
}

/**
 * Connects, collects new messages, runs this number's flows on them (replies go out
 * over the same connection), then disconnects. Replaces a bare `withWhatsApp` for syncs.
 */
export async function syncAccount(base: RawKV, a: AccountDeps, opts: { maxMs?: number; flows?: boolean } = {}) {
  const flows = opts.flows === false ? [] : await flowsFor(base, a.id);
  const paused = await isPaused(base);
  const active = flows.length > 0 && !paused;
  const ai = aiFromEnv();
  return withWhatsApp(a, async () => null, {
    maxMs: opts.maxMs ?? 60_000,
    ...(active
      ? {
          afterDrain: async ({ sock, fresh, files, deadline }) => {
            const deps: EngineDeps = { flows, state: a.raw, store: a.store, channel: personalChannel(sock, a), ai, agent: agentFromEnv(process.env, connectMcp), connectors: () => listConnectors(base), downloads: files, fileStore: { save: (b, m, n) => saveFile(base, b, m, n), load: (id) => loadFile(base, id), url: (f) => fileUrl(publicBase(), f) }, deadline, knowledge: (q) => knowledgeContext(base, q), ...engineLimits() };
            await runFlows(deps, fresh);
          },
        }
      : {}),
  });
}

type OfficialIO = { base: RawKV; store: EngineDeps["store"]; graph: { sendMessage(to: string, payload: Record<string, unknown>, replyTo?: string): Promise<{ messageId: string }>; markRead(id: string): Promise<unknown> }; normalize: (p: string) => string; state: RawKV };

/** Sending through the Cloud API, inside the 24-hour customer window only. */
export function officialChannel(io: OfficialIO): Channel {
  return {
    account: "official",
    kind: "official",
    sendText: async (chat, text, replyTo) => {
      const w = await io.store.window(chat);
      if (!w.windowOpen) throw new Error("the 24-hour window is closed; use a template");
      const save = (id: string, type: string, body: string) =>
        io.store.saveMessage({ id, waId: chat, direction: "out", type, text: body, timestamp: Math.floor(Date.now() / 1000), status: "sent", source: "api", replyTo });
      const button = linkButton(text);
      if (button) {
        try {
          const res = await io.graph.sendMessage(chat, ctaPayload(button), replyTo);
          await save(res.messageId, "interactive", `${button.body}\n[${button.label}: ${button.url}]`);
          return res.messageId;
        } catch {
          // a rejected button must not lose the reply: send it as text below
        }
      }
      const body = plainLinks(text);
      const res = await io.graph.sendMessage(chat, { type: "text", text: { body } }, replyTo);
      await save(res.messageId, "text", body);
      return res.messageId;
    },
    react: async (chat, msg, emoji) => void (await io.graph.sendMessage(chat, { type: "reaction", reaction: { message_id: msg.id, emoji } })),
    markRead: async (_chat, msg) => void (await io.graph.markRead(msg.id)),
    resolveTarget: io.normalize,
  };
}

/** Everything the engine needs besides the flows and the channel, for one number. */
export const engineExtras = (base: RawKV): Omit<EngineDeps, "flows" | "state" | "store" | "channel"> => ({
  ai: aiFromEnv(),
  agent: agentFromEnv(process.env, connectMcp),
  connectors: () => listConnectors(base),
  knowledge: (q) => knowledgeContext(base, q),
  ...engineLimits(),
});

/** Runs the flows of the official number on messages the webhook just stored. */
export async function runOfficialFlows(fresh: StoredMessage[], io: OfficialIO) {
  const flows = await flowsFor(io.base, "official");
  if (!flows.length || (await isPaused(io.base))) return [];
  const channel = officialChannel(io);
  const deps: EngineDeps = { flows, state: io.state, store: io.store, channel, deadline: Date.now() + 45_000, ...engineExtras(io.base), meetings: meetings(io.base, io.store) };
  const logs = await runFlows(deps, fresh);
  // a merchant whose last message got no answer gets one more look while the window is open
  logs.push(...(await catchUpUnanswered(deps).catch((e) => (console.error("catch-up failed", e), []))));
  // Every wake-up (a message or the cron ping) also checks for merchants who went quiet and meetings due today.
  await sendFollowups({ store: io.store, state: io.state, channel }).catch((e) => console.error("follow-ups failed", e));
  await sendMeetingReminders({ base: io.base, store: io.store, state: io.state, channel }).catch((e) => console.error("meeting reminders failed", e));
  return logs;
}
