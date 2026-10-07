# Keystone Generator

Finds local businesses, works out what's wrong with their website, writes a personalised email and SMS with Claude, runs it through approval rules, sends it via Resend/Gmail and Twilio, and tracks every lead in a small CRM.

```
Lead Generator ──► Find Business (Google Places / CSV import)
                        │
                        ▼
   Enrich: business name · contact name · email · phone · website
           industry · city · website problems/opportunities · fit score
                        │
                        ▼
        AI Personalization Agent (Claude) → email + SMS draft
                        │
                        ▼
            Approval / Automation Rules
                        │
            ┌───────────┴───────────┐
            ▼                       ▼
     EMAIL (Resend / Gmail)    TEXT (Twilio)
            └───────────┬───────────┘
                        ▼
       CRM: Sent → Delivered → Replied → Interested → Booked → Closed
            (+ skipped · lost · opted_out · bounced)
```

## Quick start

```bash
npm install
cp .env.example .env        # add your keys; DRY_RUN=true by default, so nothing is sent
npm run build

# find leads and run everything (dry run)
node dist/cli.js run --industry "plumber" --city "Austin, TX" --limit 20

# or step by step
node dist/cli.js find --industry dentist --city "Denver, CO"
node dist/cli.js import leads.csv          # alternative to Google Places
node dist/cli.js enrich                    # contacts + website audit + score
node dist/cli.js draft                     # Claude writes email + SMS, rules decide
node dist/cli.js queue                     # review what's waiting
node dist/cli.js approve --id 3 [--sms-consent]
node dist/cli.js send                      # send everything approved and due

# dashboard + webhooks (+ send due messages every 15 min)
node dist/cli.js serve --send-every 15     # http://localhost:3000
```

During development you can run `npm run dev -- <command>` to skip the build step.

Requires Node 22.5+ (uses the built-in `node:sqlite`).

## Stages

| Stage | Code | What it does |
|---|---|---|
| Find business | `src/leads/finder.ts` | Google Places API (New) Text Search, or CSV import. Dedupes by place id, website domain and phone. |
| Enrich | `src/leads/enrich.ts` | Scrapes the homepage and its contact/about pages for emails (on-domain and personal addresses first) and the owner's name (JSON-LD `founder`/`employee`, "Owner: …", "Hi, I'm …"). Falls back to Hunter.io if `HUNTER_API_KEY` is set. |
| Website problems/opportunities | `src/leads/audit.ts` | No HTTPS, not mobile-friendly, missing title/meta/H1, slow load, outdated copyright, legacy markup, images without alt text, no contact form, no online booking, no click-to-call, no schema, no analytics, no reviews, no social links, no website at all, site down. Produces a 0–100 fit score. |
| AI personalization | `src/ai/personalize.ts` | Claude (`claude-opus-5-5`, adaptive thinking, structured JSON output) writes a subject, a 70–130 word email and a sub-280-character SMS that open with the most concrete audit finding. Scraped content is treated as untrusted. Server-side refusal fallback is on (`fallbacks: "default"`). |
| Approval / automation rules | `src/rules.ts` | **Manual mode** (default): every draft waits in the approval queue. **Auto mode**: leads at or above `AUTO_APPROVE_MIN_SCORE` that have an email are approved; the rest wait. Leads are always skipped when they're opted out or suppressed, have no contact info, are on a blocked domain or industry, or score below `MIN_SCORE`. Every send checks the send window and timezone, weekends, daily caps, SMS consent, and an SMS follow-up delay. |
| Email | `src/channels/email.ts` | Resend (HTTP API, `List-Unsubscribe` one-click headers) or Gmail (SMTP + App Password). Adds a CAN-SPAM footer (company, physical address, unsubscribe link). |
| Text | `src/channels/sms.ts` | Twilio REST API with a status callback. Appends "Reply STOP to opt out." |
| CRM | `src/crm/db.ts`, `src/pipeline.ts` | SQLite: leads, drafts, messages, a per-lead event timeline, and a suppression list. Stages only move forward, so a late "delivered" webhook can't undo "replied". |
| Reply handling | `src/pipeline.ts` | Inbound replies are matched to a lead. STOP/unsubscribe keywords are honoured immediately; everything else is classified by Claude as interested, booked, not interested, question, or out of office, and the lead's stage moves with it. Claude's suggested response is saved to the timeline. |

## Webhooks

Set `PUBLIC_BASE_URL` to the server's public URL, then point the providers at:

| Provider | URL | Events |
|---|---|---|
| Resend | `POST /webhooks/resend` | `email.delivered`, `email.bounced`, `email.complained`, `email.received` (inbound replies). Verified with `RESEND_WEBHOOK_SECRET` (Svix signature). |
| Twilio status | `POST /webhooks/twilio/status` | Set automatically on every send. Verified with `X-Twilio-Signature`. |
| Twilio inbound | `POST /webhooks/twilio/inbound` | Set as the number's "A message comes in" webhook. |
| Any inbound email | `POST /webhooks/email/inbound` | JSON `{ "from": "...", "text": "..." }` with `Authorization: Bearer $DASHBOARD_TOKEN`. Use this for Gmail (Apps Script / Zapier forwarding replies). |

Unsubscribe links (`/unsubscribe/:id/:token`) are signed with HMAC using `APP_SECRET`. They support GET and RFC 8058 one-click POST.

## Dashboard

`serve` hosts a single-page dashboard with:

- the find form
- pipeline counts for each stage (click one to filter)
- an approval queue where you can edit the email/SMS, record SMS consent, approve, approve and send, redraft with AI, or reject
- a detail view for each lead with the audit findings, messages, timeline, and manual stage buttons (interested, booked, closed, lost, opted out)

Set `DASHBOARD_TOKEN` before exposing it to the internet.

## Compliance notes

- **SMS (TCPA):** cold texting US numbers without prior consent can cost $500–$1,500 per message. `SMS_REQUIRE_CONSENT=true` (the default) blocks texts to any lead without recorded consent. Set consent via a CSV `sms_consent` column, `approve --sms-consent`, or the checkbox in the dashboard. Register your number for A2P 10DLC with Twilio.
- **Email (CAN-SPAM / GDPR):** every email gets your physical address and a working unsubscribe link. Opt-outs, bounces and spam complaints are added to a permanent suppression list. For EU/UK prospects, check you have a lawful basis before emailing.
- Use a separate sending subdomain (e.g. `mail.your-domain.com`) with SPF, DKIM and DMARC set up, and keep the daily caps low while it warms up.

## Tests

```bash
npm test         # node:test, with fake fetch/AI/senders — no network or keys needed
npm run typecheck
```
