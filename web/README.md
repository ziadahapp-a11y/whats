# whats-mcp on Vercel

This folder is a Next.js app that hosts the landing page and two MCP servers:

- `/api/personal/mcp`: your **personal** WhatsApp account as a linked device, connected on demand (see [Personal mode](#personal-mode-on-vercel) below).
- `/api/mcp`: a **WhatsApp Business** number through Meta's official Cloud API (the rest of this section).

## Quick start (personal account on Vercel)

1. **Deploy.** Click *Deploy* on the landing page. It creates your own Vercel project and an Upstash Redis database. Enter two random passwords (the landing page has a button that generates them in your browser): `MCP_SECRET` and `CRON_SECRET`.
2. **Turn off Deployment Protection** (Project Settings → Deployment Protection → Vercel Authentication off for production), otherwise Claude cannot reach your URL.
3. **Add an AI key** (optional but needed for replies, summaries and the WhatsApp assistant), then redeploy:
   - cheap: `AI_COMPAT_URL=https://api.deepseek.com`, `AI_COMPAT_KEY=<key>`, `AI_COMPAT_MODEL=deepseek-flash` (+ `AI_COMPAT_VISION=1` if the model reads images), or
   - Claude: `ANTHROPIC_API_KEY=<key>`.
4. **Open `/personal`**, enter `MCP_SECRET`, link your number with the pairing code, and press *Test AI* to check the key and model name.
5. **Connect your assistant:** create a device key in `/personal` and paste the ready-made URL (`.../api/personal/mcp?key=wmk_...`) into Claude, Cursor or Claude Code.

Full walkthrough with every variable and troubleshooting: `/guide` on your deployment. Handing the system to a customer: [docs/CUSTOMERS.md](../docs/CUSTOMERS.md). Updates and customer feedback: [docs/UPDATES.md](../docs/UPDATES.md).

## Official mode

- `/api/mcp` is an MCP server for a **WhatsApp Business number**, using Meta's official [Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api). `/api/webhook` receives messages from Meta, and `/setup` shows what is configured.

Unlike the local binary in the repo root, this mode is fully sanctioned by Meta, runs without your computer, and cannot read personal chats or groups.

## What you can and cannot do

| | |
|---|---|
| Read | Messages received after the webhook is connected, plus messages sent through this server and (with Coexistence) echoes of what you send from the WhatsApp Business app. Meta has no API for older history. |
| Reply freely | Within 24 hours of the customer's last message (`send_text`, `send_media`, `send_buttons`, `send_reaction`). |
| Start a conversation / reply after 24 h | Only with an approved template (`send_template`). |
| Cost | Meta bills per delivered template message by category and country; each number gets 1,000 free service messages a month. Hosting fits Vercel's and Upstash's free tiers for small volumes. |

## Tools (12)

`list_conversations`, `list_messages`, `search_messages`, `get_media`, `list_templates`, `get_number_status`, `send_text`, `send_media`, `send_template`, `send_buttons`, `send_reaction`, `mark_read`.

## Setup

1. **Meta app.** At [developers.facebook.com/apps](https://developers.facebook.com/apps) create a *Business* app and add the WhatsApp product. Add your number (or onboard your existing WhatsApp Business app number with **Coexistence** to keep using the app). Create a **System User** in Business Settings with `whatsapp_business_messaging` and `whatsapp_business_management`, and generate a permanent token.
2. **Deploy.** Use the Deploy button on the landing page, or import this repo in Vercel with **Root Directory = `web`**. Set:

   | Variable | Value |
   |---|---|
   | `WHATSAPP_ACCESS_TOKEN` | the System User token |
   | `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp > API Setup |
   | `WHATSAPP_WABA_ID` | WhatsApp Business Account ID (for `list_templates`) |
   | `META_APP_SECRET` | App settings > Basic > App secret |
   | `WEBHOOK_VERIFY_TOKEN` | any random string |
   | `MCP_SECRET` | random, 24+ characters (`openssl rand -hex 24`) |
   | `GRAPH_API_VERSION` | optional, defaults to `v26.0` |

3. **Storage.** In the Vercel project: *Storage → Upstash Redis → Connect*. This adds `KV_REST_API_URL` / `KV_REST_API_TOKEN`. Redeploy.
4. **Webhook.** In the Meta app: *WhatsApp → Configuration*. Callback URL `https://<your-app>.vercel.app/api/webhook`, verify token = `WEBHOOK_VERIFY_TOKEN`. Subscribe to `messages`, and to `smb_message_echoes` if you use Coexistence.
5. **Check.** Open `https://<your-app>.vercel.app/setup?key=<MCP_SECRET>`.
6. **Connect your assistant.**

   ```json
   { "mcpServers": { "whatsapp-business": {
       "type": "http",
       "url": "https://<your-app>.vercel.app/api/mcp",
       "headers": { "Authorization": "Bearer <MCP_SECRET>" }
   } } }
   ```

   Clients that only accept a URL can use `https://<your-app>.vercel.app/api/mcp?key=<MCP_SECRET>`; treat that URL like a password.

## Personal mode on Vercel

Serverless functions cannot hold WhatsApp's connection open, so this mode connects only when needed:

1. A tool call takes a Redis lock (WhatsApp drops a device that connects twice), opens the linked-device session stored in Redis with [Baileys](https://github.com/WhiskeySockets/Baileys), and waits a few seconds while WhatsApp delivers everything queued since the last connection.
2. It runs the action (read from cache, send, react, mark read, list groups), saves the updated signal keys, and disconnects.
3. Read tools reuse the cache when it is under 2 minutes old. A daily cron (`/api/cron/sync`, needs `CRON_SECRET`) keeps the device from being unlinked for inactivity.

Setup: deploy, connect Upstash Redis, set `MCP_SECRET` and `CRON_SECRET`, then open `/personal`, enter the secret and your number, and type the pairing code on your phone (*Linked devices → Link with phone number instead*). Connect clients to `https://<your-app>.vercel.app/api/personal/mcp`.

Tools (12): `list_accounts`, `get_status`, `sync`, `list_chats`, `list_messages`, `search_messages`, `send_message`, `send_media`, `send_reaction`, `mark_read`, `list_groups`, `check_numbers`.

Trade-offs versus the local binary: each call that connects takes ~5–20 s; history before linking is only what WhatsApp pushes during pairing; and connecting from datacenter IPs raises the chance WhatsApp restricts the number. It is not sanctioned by Meta: use it for your own account and keep volume low.

## Security

- `/api/mcp`, `/api/personal/*` refuse every request until `MCP_SECRET` (24+ chars) is set, and then requires it.
- `/api/webhook` rejects any POST whose `X-Hub-Signature-256` does not match `META_APP_SECRET`, and ignores events for other numbers on the same WABA.
- `/setup` shows only which variables are present; live checks require the secret.
- Customer messages are untrusted input. The server's instructions tell the model to treat them as data and to confirm sends with you, but keep approval prompts on for send tools.

## Development

```bash
npm install
npm test        # unit tests (store, webhook parsing, signatures, auth)
npm run build
npm run e2e     # boots the build and exercises webhook + MCP end to end, without calling Meta
npm run dev     # without Redis env vars, an in-memory store is used
```
