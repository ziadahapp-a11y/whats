// Thin client for the official WhatsApp Cloud API (Meta Graph API).

import type { Config } from "./config";
import type { TemplateInfo } from "./preflight";

export class GraphError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number,
  ) {
    super(message);
  }
}

/** Strips "+", spaces, dashes and brackets so "+966 50-123 4567" becomes "966501234567". */
export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    throw new Error(`"${input}" is not a valid phone number: use the full international number with country code, e.g. 966501234567`);
  }
  return digits;
}

/** A business-scoped user id such as "US.13491208655302741918": Meta sends it instead of the phone number for some customers. */
export const isBsuid = (id: string) => /^[A-Z]{2}\.[A-Za-z0-9.]+$/.test(id);

export type SendResult = { messageId: string; waId?: string };

export class Graph {
  constructor(
    private cfg: Config,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private base() {
    return `https://graph.facebook.com/${this.cfg.graphVersion}`;
  }

  async call<T = any>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
    if (!this.cfg.accessToken) throw new GraphError("WHATSAPP_ACCESS_TOKEN is not set", 500);
    const url = new URL(this.base() + path);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${this.cfg.accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) {
      const e = data?.error ?? {};
      const detail = e.error_data?.details ? ` (${e.error_data.details})` : "";
      throw new GraphError(`${e.message ?? res.statusText}${detail}`, res.status, e.code);
    }
    return data as T;
  }

  /** POST /{phone-number-id}/messages with the common envelope filled in. */
  async sendMessage(to: string, payload: Record<string, unknown>, replyTo?: string): Promise<SendResult> {
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      ...(isBsuid(to) ? { recipient: to } : { to: normalizePhone(to) }),
      ...payload,
    };
    if (replyTo) body.context = { message_id: replyTo };
    const data = await this.call<{ contacts?: { wa_id: string }[]; messages: { id: string }[] }>(`/${this.cfg.phoneNumberId}/messages`, { body });
    return { messageId: data.messages?.[0]?.id ?? "", waId: data.contacts?.[0]?.wa_id };
  }

  /** Marks an inbound message (and everything before it) as read; optionally shows "typing…". */
  async markRead(messageId: string, typing = false) {
    return this.call(`/${this.cfg.phoneNumberId}/messages`, {
      body: {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        ...(typing ? { typing_indicator: { type: "text" } } : {}),
      },
    });
  }

  private waba() {
    if (!this.cfg.wabaId) throw new GraphError("WHATSAPP_WABA_ID is not set", 500);
    return this.cfg.wabaId;
  }

  async listTemplates(status?: string, limit = 50) {
    const query: Record<string, string> = { fields: "name,status,language,category,components", limit: String(limit) };
    if (status) query.status = status;
    return this.call<{ data: unknown[] }>(`/${this.waba()}/message_templates`, { query });
  }

  /** Submits a template for review; the body comes from compileTemplate(). Meta replies with status PENDING. */
  async createTemplate(payload: Record<string, unknown>) {
    return this.call<{ id: string; status: string; category: string }>(`/${this.waba()}/message_templates`, { body: payload });
  }

  /** One template by exact name (and language when given), with review status, quality and any rejection reason. */
  async getTemplate(name: string, language?: string) {
    const res = await this.call<{ data: any[] }>(`/${this.waba()}/message_templates`, {
      query: { name, fields: "id,name,status,language,category,components,quality_score,rejected_reason", limit: "50" },
    });
    // Meta's name filter is a substring match, so keep the exact name only.
    return res.data.find((t) => t.name === name && (!language || t.language === language)) ?? null;
  }

  /** The template as the campaign preflight reads it, or null when it does not exist. */
  async getTemplateInfo(name: string, language: string): Promise<TemplateInfo | null> {
    const t = await this.getTemplate(name, language);
    if (!t) return null;
    const body = (t.components ?? []).find((c: any) => c.type === "BODY");
    const paramCount = new Set([...String(body?.text ?? "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
    return { name: t.name, language: t.language, status: t.status, category: t.category, quality: t.quality_score?.score, paramCount };
  }

  /** Deletes every language version of the template with this name. */
  async deleteTemplate(name: string) {
    return this.call<{ success: boolean }>(`/${this.waba()}/message_templates`, { method: "DELETE", query: { name } });
  }

  /** Registers the number on the Cloud API. The 6-digit PIN becomes its two-step verification PIN: keep it. */
  async registerPhone(pin: string) {
    if (!/^\d{6}$/.test(pin)) throw new Error("The PIN must be exactly 6 digits.");
    return this.call<{ success: boolean }>(`/${this.cfg.phoneNumberId}/register`, { body: { messaging_product: "whatsapp", pin } });
  }

  async phoneInfo() {
    return this.call(`/${this.cfg.phoneNumberId}`, {
      query: { fields: "display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,throughput,messaging_limit_tier,status,name_status" },
    });
  }

  async businessProfile() {
    return this.call(`/${this.cfg.phoneNumberId}/whatsapp_business_profile`, {
      query: { fields: "about,address,description,email,websites,vertical" },
    });
  }

  /** Resolves a media ID to its metadata, then downloads the bytes (the URL needs the same token). */
  async downloadMedia(mediaId: string, maxBytes = 5 * 1024 * 1024) {
    const meta = await this.call<{ url: string; mime_type: string; file_size: number; sha256: string }>(`/${mediaId}`);
    if (meta.file_size > maxBytes) return { meta, bytes: null as Uint8Array | null };
    const res = await this.fetchImpl(meta.url, { headers: { Authorization: `Bearer ${this.cfg.accessToken}` } });
    if (!res.ok) throw new GraphError(`media download failed: ${res.status}`, res.status);
    return { meta, bytes: new Uint8Array(await res.arrayBuffer()) };
  }
}
