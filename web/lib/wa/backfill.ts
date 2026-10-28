// Pulls older messages from the phone, chat by chat, in slices that fit one
// serverless call. WhatsApp only answers "give me the 50 messages before this
// one" (a linked device cannot ask for everything at once), so we keep asking
// from the oldest message we hold until the phone has nothing earlier.
// Progress is saved, so each call continues where the last one stopped.

import type { WASocket } from "baileys";
import type { Store } from "../store";
import type { RawKV } from "./auth";
import { keyFor } from "./ops";
import { withWhatsApp, type SessionDeps } from "./session";

const STATE = "wa:backfill";
const PAGE = 50;

export type BackfillState = {
  done: string[]; // chats with nothing older left on the phone
  added: number; // messages fetched in total
  startedAt: number;
  finishedAt?: number;
};

export type BackfillProgress = BackfillState & { chats: number; left: number; finished: boolean; addedNow: number };

export async function readBackfill(raw: RawKV): Promise<BackfillState | null> {
  const v = await raw.get(STATE);
  return v ? (JSON.parse(v) as BackfillState) : null;
}

export async function resetBackfill(raw: RawKV) {
  await raw.del(STATE);
}

type Opts = { maxMs?: number; waitMs?: number };

/** Asks the phone for one page older than the oldest message we hold; true when something new arrived. */
async function olderPage(sock: WASocket, store: Store, chat: string, waitMs: number): Promise<boolean> {
  const oldest = await store.oldest(chat);
  if (!oldest) return false;
  await sock.fetchMessageHistory(PAGE, keyFor(chat, oldest.id, oldest), oldest.timestamp * 1000);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 400));
    const now = await store.oldest(chat);
    if (now && now.timestamp < oldest.timestamp) {
      await new Promise((r) => setTimeout(r, 1_200)); // let the rest of the page land
      return true;
    }
  }
  return false;
}

export async function backfillStep(d: SessionDeps, opts: Opts = {}): Promise<BackfillProgress> {
  const maxMs = opts.maxMs ?? 100_000;
  const waitMs = opts.waitMs ?? 9_000;
  let state: BackfillState = (await readBackfill(d.raw)) ?? { done: [], added: 0, startedAt: Math.floor(Date.now() / 1000) };
  const all = await d.store.allChats();
  const done = new Set(state.done);
  let todo = all.filter((c) => !done.has(c));
  const startedWith = state.added;

  if (todo.length) {
    const { ingested } = await withWhatsApp(
      d,
      async (sock) => {
        const stop = Date.now() + maxMs - 25_000; // leave room to connect, flush and disconnect
        for (const chat of todo) {
          while (Date.now() < stop) {
            let got = false;
            // One retry: the phone sometimes needs a moment to answer.
            for (let i = 0; i < 2 && !got && Date.now() < stop; i++) got = await olderPage(sock, d.store, chat, waitMs);
            if (!got) {
              done.add(chat);
              break;
            }
          }
          if (Date.now() >= stop) break;
        }
      },
      { maxMs, drain: false },
    );
    state.added += ingested;
    todo = all.filter((c) => !done.has(c));
  }

  state = { ...state, done: [...done], ...(todo.length ? {} : { finishedAt: Math.floor(Date.now() / 1000) }) };
  await d.raw.set(STATE, JSON.stringify(state));
  return { ...state, chats: all.length, left: todo.length, finished: todo.length === 0, addedNow: state.added - startedWith };
}
