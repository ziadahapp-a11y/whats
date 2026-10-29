// One follow-up on the official number when a merchant has gone quiet: our side wrote last and the
// merchant's last message is 20 hours old, so the reminder still lands inside the 24-hour window.

import type { RawKV } from "../wa/auth";
import type { Store } from "../store";
import type { Channel } from "./engine";

export const FOLLOWUP_TEXT = "حياك الله، ننتظر ردك عشان نكمل معك";
export const FOLLOWUP_AFTER = 20 * 3600;
/** the reminder must leave before the window closes at 24 hours */
const LATEST = 23.5 * 3600;

/** Our last message ended the exchange (handoff, opt-out, thanks), so the merchant owes no reply. */
const CLOSED = /جاري تحويلك للفريق|تم إيقاف الرسائل|سعدنا بخدمتك|ننتظر ردك عشان نكمل معك|موعدنا|حاضرين لأي|العفو/;

export async function sendFollowups(d: { store: Store; state: RawKV; channel: Channel }, now = Math.floor(Date.now() / 1000), scan = 200): Promise<string[]> {
  const convs = await d.store.conversations(scan, undefined, now);
  const due = convs.filter((c) => {
    const age = c.lastInboundAt ? now - c.lastInboundAt : -1;
    return age >= FOLLOWUP_AFTER && age < LATEST && c.last?.direction === "out" && !CLOSED.test(c.last.text ?? "");
  });
  if (!due.length) return [];
  const out = await d.store.optedOut(due.map((c) => c.waId));
  const sent: string[] = [];
  for (const c of due) {
    if (out.has(c.waId)) continue;
    // once per quiet spell: the marker is keyed on the merchant's last message
    if (!(await d.state.set(`fu:${c.waId}:${c.lastInboundAt}`, "1", { ex: 3 * 86400, nx: true }))) continue;
    try {
      await d.channel.sendText(c.waId, FOLLOWUP_TEXT);
      sent.push(c.waId);
    } catch (e) {
      console.error("follow-up failed", c.waId, e);
    }
  }
  return sent;
}
