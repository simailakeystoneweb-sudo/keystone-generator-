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
| Email | `src/services/email/resend.ts` | `sendLeadEmail()` through the official Resend SDK (or Gmail SMTP). Adds a CAN-SPAM footer (company, physical address, unsubscribe link) and `List-Unsubscribe` one-click headers. |
| Text | `src/services/sms/twilio.ts` | `sendLeadSMS()` through the official Twilio SDK, with a status callback. Appends "Reply STOP to opt out." Handles inbound texts and STOP keywords. |
| CRM | `src/crm/db.ts`, `src/pipeline.ts` | SQLite: leads, drafts, `communications` (every inbound and outbound email/SMS), a per-lead event timeline, and a suppression list. Stages only move forward, so a late "delivered" webhook can't undo "replied". |
| Reply handling | `src/services/replies.ts` | Inbound replies are matched to a lead, recorded, mark the lead replied and pause the sequence. Opt-out keywords and phrases are honoured immediately; everything else is classified by Claude, the classification is stored, and the lead's stage moves with it. |

## Claude service

All Claude calls go through `src/ai/claude.ts` (`ClaudeService`), which runs **only on the server**. It reads `ANTHROPIC_API_KEY` from the environment. The browser never sees the key and never calls Anthropic: the dashboard posts to this server's `/api/ai/*` routes, and they return only the generated JSON.

| Function | Returns |
|---|---|
| `analyzeLead({ businessName, website, industry, city, description, knownWebsiteIssues, notes })` | `{ leadScore, websiteScore, quality: LOW\|MEDIUM\|HIGH, summary, painPoints[], recommendedOffer, recommendedChannel: EMAIL\|SMS\|BOTH, reasonForContacting }` |
| `generateColdEmail({ lead, analysis? })` | `{ subject, body }`, written as Keystone Web Agency (professional, friendly, confident, short, personalized, not spammy) |
| `generateColdSMS({ lead, analysis? })` | `{ message }` (casual, professional, human, short) |
| `generateFollowUp({ lead, analysis?, channel: EMAIL\|SMS, followUpNumber?, previousMessages?, daysSinceLastMessage? })` | `{ channel: "EMAIL", subject, body }` or `{ channel: "SMS", message }` |
| `classifyReply({ replyText, channel?, businessName?, originalMessage? })` | `{ classification, sentiment, recommendedAction, shouldPauseSequence }` |

Reply classifications are `INTERESTED`, `MEETING_BOOKED`, `QUESTION`, `NOT_INTERESTED`, `UNSUBSCRIBE`, `WRONG_PERSON`, `OUT_OF_OFFICE` and `OTHER`. Sentiment is `POSITIVE`, `NEUTRAL` or `NEGATIVE`. `shouldPauseSequence` is always true for a real human reply; only out-of-office auto-replies keep the sequence running.

Every request uses `claude-opus-5-5` (override with `ANTHROPIC_MODEL`) with adaptive thinking, structured JSON output validated with Zod, and the server-side refusal fallback. Scraped and user-supplied text is marked as untrusted in the prompts.

### Endpoints

All are `POST`, require `Authorization: Bearer $DASHBOARD_TOKEN`, are rate limited (`AI_RATE_LIMIT_PER_MINUTE`), and **never send email or SMS**. If `DASHBOARD_TOKEN` isn't set, the AI routes only accept requests from localhost.

| Endpoint | Body | Saves |
|---|---|---|
| `/api/ai/analyze-lead` | `analyzeLead` input | nothing (stateless) |
| `/api/ai/generate-cold-email` | `{ lead, analysis? }` | nothing |
| `/api/ai/generate-cold-sms` | `{ lead, analysis? }` | nothing |
| `/api/ai/generate-follow-up` | `generateFollowUp` input | nothing |
| `/api/ai/classify-reply` | `classifyReply` input | nothing |
| `/api/ai/leads/:id/analyze` | `{ description?, notes?, knownWebsiteIssues? }` | analysis + score on the lead |
| `/api/ai/leads/:id/email` | — | a new **unapproved** draft |
| `/api/ai/leads/:id/sms` | — | a new **unapproved** draft |
| `/api/ai/leads/:id/follow-up` | `{ channel }` | nothing (returned for review) |
| `/api/ai/leads/:id/classify-reply` | `{ replyText, channel? }` | the reply + CRM stage |
| `GET /api/ai/status` | — | — (reports whether Claude is configured) |

Errors come back as `400` (invalid input, with the issues listed), `404` (unknown lead), `429` (rate limited), `502` (Claude failed or declined) or `503` (`ANTHROPIC_API_KEY` not set). Provider error details are logged on the server, not returned to the browser.

Generated copy is saved as a new unapproved draft, and sending requires the latest draft to be approved. So generating new copy also holds anything that was approved earlier, until a person approves it again.

### Lead Details page

`/leads/:id` (click any lead on the dashboard) shows the lead, its website audit and editable context (description, known issues, notes), plus **Analyze Lead**, **Generate Email** and **Generate SMS** buttons. Each button shows a spinner and a busy label while it runs. The page also has follow-up generation, reply classification, an editable email/SMS draft with word and SMS-segment counters, contact preferences, the last reply's classification, and the communications log.

The AI buttons never send anything. Messages only go out through **Send Email…** and **Send Text…**, each of which opens a confirmation modal first (see below).

## Sending email (Resend)

`sendLeadEmail({ leadId, email, subject, body, campaignId? })` in `src/services/email/resend.ts`:

1. Loads the lead from the database.
2. Confirms it has an email address, and that `email` is that address (the API can't be used to email anyone else).
3. Confirms `email_opt_out` is false.
4. Confirms `do_not_contact` is false, and that the address isn't suppressed (bounced, complained or unsubscribed).

If any check fails the send is rejected (`SendRejectedError` with a code such as `EMAIL_OPT_OUT`) and nothing is sent. On success it records a `communications` row (`direction = OUTBOUND`, `channel = EMAIL`, `provider = RESEND`, `provider_message_id`, `subject`, `body`, `sent_at`). It then updates the lead: `email_status = SENT`, `last_contacted_at = now`, and the status becomes contacted (`sent`) if the lead hadn't been contacted yet. Leads already further along (replied, interested…) keep their stage. If Resend rejects the email, a `FAILED` communication is recorded and the lead is unchanged.

Setup: `RESEND_API_KEY`, `OUTREACH_FROM_EMAIL` (on a domain verified in Resend) and `OUTREACH_FROM_NAME` (default `Keystone Web Agency`). Add a Resend webhook pointing at `/webhooks/resend` and set `RESEND_WEBHOOK_SECRET`; delivered, bounced and complained events then update `email_status`.

## Sending SMS (Twilio)

`sendLeadSMS({ leadId, phone, message, campaignId? })` in `src/services/sms/twilio.ts`:

1. Loads the lead.
2. Confirms the phone number is valid (strict E.164, NANP rules for +1) and is the lead's own number.
3. Confirms `sms_opt_out` is false.
4. Confirms `do_not_contact` is false and the number isn't suppressed. Consent is also required (`SMS_REQUIRE_CONSENT`, default on), and nothing is sent during quiet hours (`SMS_QUIET_HOURS_START`/`END`, default 9pm–8am in `TIMEZONE`).

If any check fails the send is rejected and nothing is sent. On success it records `OUTBOUND / SMS / TWILIO` with `provider_message_id`, `body` and `sent_at`. It then sets `sms_status = SENT` and `last_contacted_at = now`, and moves the status to contacted when appropriate. If Twilio answers with error 21610 (the number replied STOP), the lead is marked SMS opt-out.

Setup: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`. In the Twilio console, set the number's **A message comes in** webhook to `POST https://<PUBLIC_BASE_URL>/api/webhooks/twilio/incoming`.

### Incoming texts — `POST /api/webhooks/twilio/incoming`

1. Verifies `X-Twilio-Signature` with the Twilio SDK and rejects anything unsigned or forged.
2. Reads `From`, `To` and `Body`, and normalizes the phone number.
3. Finds the lead.
4. Records an `INBOUND` communication. Twilio retries are de-duplicated by `MessageSid`.
5. Marks `replied = true` and pauses the sequence (`sequence_paused = true`), so no automated follow-ups go out.
6. If the whole message is an opt-out keyword (`STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, plus `OPTOUT` and `REVOKE`; case, spaces and punctuation are ignored), sets `sms_opt_out = true` and revokes SMS consent. No future SMS can be sent. Otherwise the reply is classified by Claude in the background, and the classification is stored on the communication and the lead.

The webhook responds right away with empty TwiML. It never sends an auto-reply: Twilio Advanced Opt-Out sends the STOP/HELP/START confirmations itself. A STOP from a number that isn't a lead yet is added to the suppression list, so a later import can't text it. Phrases like "please stop texting me", or a Claude `UNSUBSCRIBE` classification, opt the lead out of both email and SMS.

**Opt-outs are permanent.** Texting `START` re-enables delivery at Twilio, but our `sms_opt_out` stays set until someone clears it on the Lead Details page (which asks for confirmation and logs who changed what). Re-imports, enrichment and approvals never clear an opt-out, and SMS consent can't be recorded while a lead is opted out.

### Confirmation modals

**Send Email…** shows the recipient, from address, subject and email body, including the footer that will be added. **Send Text…** shows the phone number and the message with its opt-out line and segment count. Each modal has **Cancel** and **Send Email** / **Send Text**. The modal checks contactability first: if the lead can't be contacted, it says why and the send button stays disabled. Each confirmation carries an idempotency key, so a double click or a retried request sends only once. Success and failure are shown as toasts. With `DRY_RUN=true` the modal says so, and the message is recorded with provider `DRY_RUN` but not delivered.

| Endpoint | Body |
|---|---|
| `GET /api/leads/:id/send-preview` | — (what the modals show, and whether each channel can be used) |
| `POST /api/leads/:id/email/send` | `{ email, subject, body, campaignId?, idempotencyKey? }` |
| `POST /api/leads/:id/sms/send` | `{ phone, message, campaignId?, idempotencyKey? }` |
| `PATCH /api/leads/:id/contact-preferences` | `{ emailOptOut?, smsOptOut?, doNotContact?, smsConsent?, sequencePaused? }` |

These routes require `DASHBOARD_TOKEN` (or a localhost request if it isn't set) and are rate limited (`SEND_RATE_LIMIT_PER_MINUTE`). Rejections return `422` with a `code`, provider failures return `502`, and the Resend/Twilio keys never appear in any response.

## Webhooks

Set `PUBLIC_BASE_URL` to the server's public URL, then point the providers at:

| Provider | URL | Events |
|---|---|---|
| Resend | `POST /webhooks/resend` | `email.delivered`, `email.bounced`, `email.complained`, `email.failed`, `email.received` (inbound replies). Requires `RESEND_WEBHOOK_SECRET` (Svix signature); unsigned calls are refused. |
| Twilio inbound | `POST /api/webhooks/twilio/incoming` | Set as the number's "A message comes in" webhook. |
| Twilio status | `POST /api/webhooks/twilio/status` | Set automatically on every send. |
| Any inbound email | `POST /webhooks/email/inbound` | JSON `{ "from": "...", "text": "..." }` with `Authorization: Bearer $DASHBOARD_TOKEN`. Use this for Gmail (Apps Script / Zapier forwarding replies). |

Both Twilio webhooks require a valid `X-Twilio-Signature` (checked with the Twilio SDK against `PUBLIC_BASE_URL` + path, so `PUBLIC_BASE_URL` must match the URL configured in Twilio). Without `TWILIO_AUTH_TOKEN` they refuse every request. The older `/webhooks/twilio/inbound` and `/webhooks/twilio/status` URLs still work.

Unsubscribe links (`/unsubscribe/:id/:token`) are signed with HMAC using `APP_SECRET`. They support GET and RFC 8058 one-click POST, and set `email_opt_out`.

## Dashboard

`serve` hosts a single-page dashboard with:

- the find form
- pipeline counts for each stage (click one to filter)
- an approval queue where you can edit the email/SMS, record SMS consent, approve, redraft with AI, or reject (**Review & send…** opens the lead page, where sending is confirmed in a modal)
- **Send due**, which asks for confirmation and then sends approved messages under the automation rules
- the Lead Details page for each lead (above)

Set `DASHBOARD_TOKEN` before exposing it to the internet.

## Compliance notes

- **SMS (TCPA / CTIA):** cold texting US numbers without prior consent can cost $500–$1,500 per message. `SMS_REQUIRE_CONSENT=true` (the default) blocks texts to any lead without recorded consent. Set consent via a CSV `sms_consent` column, `approve --sms-consent`, or the checkbox on the Lead Details page. Texts aren't sent during quiet hours, and every text carries opt-out instructions. Keep Twilio Advanced Opt-Out enabled (the default) and register your number for A2P 10DLC. Nothing here works around Twilio's opt-out handling: opt-outs are mirrored into the CRM permanently.
- **Email (CAN-SPAM / GDPR):** every email gets your physical address and a working unsubscribe link. Opt-outs, bounces and spam complaints are added to a permanent suppression list. For EU/UK prospects, check you have a lawful basis before emailing.
- Use a separate sending subdomain (e.g. `mail.your-domain.com`) with SPF, DKIM and DMARC set up, and keep the daily caps low while it warms up.

## Tests

```bash
npm test         # node:test, with fake fetch/AI/senders — no network or keys needed
npm run typecheck
```
