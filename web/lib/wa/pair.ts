// Links this deployment as a WhatsApp "linked device" using a pairing code,
// streaming progress back to the browser as newline-delimited JSON.

import makeWASocket, { Browsers, DisconnectReason, type WASocket } from "baileys";
import pino from "pino";
import { clearAuth, redisAuthState, type RawKV } from "./auth";
import { toStored } from "./session";
import type { Store } from "../store";

export type PairEvent =
  | { type: "status"; message: string }
  | { type: "code"; code: string }
  | { type: "linked"; me?: string }
  | { type: "history"; messages: number }
  | { type: "done"; messages: number }
  | { type: "error"; message: string };

export async function pair(raw: RawKV, store: Store, phone: string, emit: (e: PairEvent) => void, budgetMs = 270_000) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) throw new Error("Enter the full WhatsApp number with country code, e.g. 966501234567");
  if (!(await raw.set("wa:lock", "pairing", { nx: true, ex: Math.ceil(budgetMs / 1000) + 20 }))) {
    throw new Error("Another WhatsApp request is running. Wait a minute and try again.");
  }
  const deadline = Date.now() + budgetMs;
  let saved = 0;
  try {
    await clearAuth(raw);
    let auth = await redisAuthState(raw);
    let codeSent = false;

    const connect = (): Promise<"restart" | "open"> =>
      new Promise((res, rej) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const resolve = (v: "restart" | "open") => (clearTimeout(timer), res(v));
        const reject = (e: unknown) => (clearTimeout(timer), rej(e));
        const sock: WASocket = makeWASocket({
          auth: auth.state,
          browser: Browsers.macOS("Chrome"),
          logger: pino({ level: "silent" }) as any,
          markOnlineOnConnect: false,
          syncFullHistory: true,
          printQRInTerminal: false,
        } as any);
        sock.ev.on("creds.update", auth.saveCreds);
        sock.ev.on("messaging-history.set", async ({ messages, contacts, chats }) => {
          for (const c of chats ?? []) if (c.id && c.name) await store.setName(c.id, c.name);
          for (const c of contacts ?? []) if (c.id && (c.name || c.notify)) await store.setName(c.id, (c.name || c.notify)!);
          for (const m of messages) {
            const s = toStored(m);
            if (s) {
              await store.saveMessage(s);
              saved++;
            }
          }
          emit({ type: "history", messages: saved });
        });
        sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
          // The QR event means the socket is ready to request a pairing code instead.
          if (qr && !codeSent) {
            codeSent = true;
            try {
              const code = await sock.requestPairingCode(digits);
              emit({ type: "code", code: code.match(/.{1,4}/g)?.join("-") ?? code });
              emit({ type: "status", message: "waiting" });
            } catch (e) {
              reject(e);
            }
          }
          if (connection === "open") {
            emit({ type: "linked", me: sock.user?.id });
            // Stay connected while WhatsApp pushes the initial history.
            const quietFor = 45_000; // the phone can take a while between history batches
            let last = Date.now();
            sock.ev.on("messaging-history.set", () => (last = Date.now()));
            while (Date.now() < deadline - 8_000 && Date.now() - last < quietFor) await new Promise((r) => setTimeout(r, 1000));
            try {
              sock.end(undefined);
            } catch {}
            resolve("open");
          }
          if (connection === "close") {
            const code = (lastDisconnect?.error as any)?.output?.statusCode;
            // After the code is accepted WhatsApp asks for one reconnect with the new keys.
            if (code === DisconnectReason.restartRequired) resolve("restart");
            else if (code === DisconnectReason.loggedOut) reject(new Error("WhatsApp rejected the link. Check the number and try again."));
            else if (Date.now() > deadline - 5_000) reject(new Error("Timed out waiting for the code to be entered."));
            else reject(new Error(`Connection closed (${code ?? "unknown"}). Try again.`));
          }
        });
        timer = setTimeout(() => {
          try {
            sock.end(undefined);
          } catch {}
          reject(new Error("Timed out. Enter the code on your phone within about 3 minutes."));
        }, Math.max(1_000, deadline - Date.now()));
      });

    let outcome = await connect();
    for (let i = 0; outcome === "restart" && i < 3; i++) {
      await auth.flush();
      auth = await redisAuthState(raw);
      outcome = await connect();
    }
    await auth.flush();
    await raw.set("wa:last-sync", String(Math.floor(Date.now() / 1000)));
    emit({ type: "done", messages: saved });
  } finally {
    await raw.del("wa:lock");
  }
}
