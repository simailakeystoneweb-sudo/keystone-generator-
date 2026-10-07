/**
 * Resend email sending. Server-side only: RESEND_API_KEY is read from the
 * environment here and never sent to the browser.
 */
import { Resend } from "resend";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { CRM } from "../../crm/db.js";
import {
  composeEmail,
  EmailProviderError,
  unsubscribeUrl,
  type EmailMessage,
  type EmailSender,
  type SendResult,
} from "../../channels/email.js";
import type { Communication, Lead } from "../../types.js";
import { applyDeliveryUpdate } from "../delivery.js";
import { contactable, notContactable, ProviderSendError, SendRejectedError, withSendLock, type Contactability } from "../errors.js";

// ---------- transport ----------

/** The slice of the Resend SDK we use (lets tests pass a fake). */
export interface ResendLike {
  emails: { send: Resend["emails"]["send"] };
}

export class ResendEmailSender implements EmailSender {
  readonly provider = "RESEND" as const;
  private client: ResendLike;
  private replyTo: string | undefined;

  constructor(opts: { apiKey?: string; replyTo?: string; client?: ResendLike }) {
    if (!opts.client && !opts.apiKey) throw new Error("RESEND_API_KEY is not set");
    this.client = opts.client ?? new Resend(opts.apiKey);
    this.replyTo = opts.replyTo || undefined;
  }

  async send(msg: EmailMessage): Promise<SendResult> {
    const tags = [{ name: "lead_id", value: String(msg.leadId) }];
    // Resend tag values allow only ASCII letters, numbers, underscores and dashes.
    if (msg.campaignId) tags.push({ name: "campaign_id", value: msg.campaignId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) });
    let res: Awaited<ReturnType<ResendLike["emails"]["send"]>>;
    try {
      res = await this.client.emails.send(
        {
          from: msg.from,
          to: [msg.to],
          replyTo: this.replyTo,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
          headers: {
            "List-Unsubscribe": `<${msg.unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
          tags,
        },
        msg.idempotencyKey ? { idempotencyKey: msg.idempotencyKey } : undefined,
      );
    } catch (err) {
      throw new EmailProviderError(`Could not reach Resend: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.error) throw new EmailProviderError(res.error.message || "Resend rejected the email", res.error.name, res.error.statusCode);
    if (!res.data?.id) throw new EmailProviderError("Resend returned no message id");
    return { provider: this.provider, providerMessageId: res.data.id };
  }
}

// ---------- sendLeadEmail ----------

export const SendLeadEmailInput = z.object({
  leadId: z.number().int().positive(),
  email: z.string().trim().toLowerCase().email().max(320),
  subject: z
    .string()
    .trim()
    .min(1, "subject is required")
    .max(300)
    .refine((s) => !/[\r\n]/.test(s), "subject must be a single line"),
  body: z.string().trim().min(1, "body is required").max(20000),
  campaignId: z.string().trim().min(1).max(100).optional(),
});
export type SendLeadEmailInput = z.input<typeof SendLeadEmailInput>;

export interface LeadEmailDeps {
  crm: CRM;
  cfg: Config;
  /** Resend (or Gmail / dry-run) transport; null when email isn't configured. */
  sender: EmailSender | null;
  now?: () => Date;
}

export interface SendOptions {
  /** Retrying with the same key returns the original result instead of sending again. */
  idempotencyKey?: string;
  draftId?: number | null;
}

export interface SendLeadEmailResult {
  communication: Communication;
  lead: Lead;
  dryRun: boolean;
  /** True when this idempotency key was already sent; nothing new went out. */
  duplicate: boolean;
}

/** Can this lead be emailed right now? Checked before every send (and shown in the confirmation modal). */
export function checkEmailContactable(crm: CRM, lead: Lead): Contactability {
  if (!lead.email) return notContactable("NO_EMAIL", "This lead has no email address.");
  if (lead.emailOptOut) return notContactable("EMAIL_OPT_OUT", "This lead has opted out of email.");
  if (lead.doNotContact) return notContactable("DO_NOT_CONTACT", "This lead is marked do not contact.");
  if (crm.isSuppressed(lead.email)) return notContactable("SUPPRESSED", "This address is on the suppression list (bounced, complained or unsubscribed).");
  return contactable();
}

/**
 * Send one email to a lead through Resend and record it.
 *
 * Before sending: loads the lead, confirms it has this email address, and that it
 * isn't opted out of email, marked do-not-contact, or suppressed. Any failure
 * rejects with SendRejectedError and nothing is sent.
 *
 * After a successful send: records an OUTBOUND / EMAIL / RESEND communication with
 * provider_message_id, subject, body and sent_at, and updates the lead
 * (email_status = SENT, last_contacted_at = now, status → contacted on first contact).
 */
export async function sendLeadEmail(input: SendLeadEmailInput, deps: LeadEmailDeps, opts: SendOptions = {}): Promise<SendLeadEmailResult> {
  const parsed = SendLeadEmailInput.safeParse(input);
  if (!parsed.success) {
    throw new SendRejectedError("INVALID_INPUT", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  }
  const { leadId, email, subject, body, campaignId } = parsed.data;
  const { crm, cfg, sender } = deps;
  const now = deps.now ?? (() => new Date());

  if (opts.idempotencyKey) {
    const prior = crm.findCommunicationByIdempotencyKey(opts.idempotencyKey);
    if (prior) {
      if (prior.leadId !== leadId || prior.channel !== "EMAIL") throw new SendRejectedError("INVALID_INPUT", "idempotency key was already used for a different send");
      return { communication: prior, lead: crm.getLead(leadId)!, dryRun: prior.provider === "DRY_RUN", duplicate: true };
    }
  }

  // 1. Load the lead.
  const lead = crm.getLead(leadId);
  if (!lead) throw new SendRejectedError("LEAD_NOT_FOUND", `Lead ${leadId} not found.`);
  // 2-4. Email exists, not opted out, not do-not-contact (+ suppression list).
  const check = checkEmailContactable(crm, lead);
  if (!check.ok) throw new SendRejectedError(check.code!, check.message);
  // The address must be the lead's own — the API can't be used to email arbitrary people.
  if (email !== lead.email!.trim().toLowerCase()) throw new SendRejectedError("EMAIL_MISMATCH", "That email address doesn't match this lead's email.");
  if (!sender) throw new SendRejectedError("NOT_CONFIGURED", "Email sending is not configured (set RESEND_API_KEY).");
  if (!cfg.emailFrom) throw new SendRejectedError("NOT_CONFIGURED", "Set OUTREACH_FROM_EMAIL to send email.");

  return withSendLock(crm, `email:${leadId}`, async () => {
    const unsubUrl = unsubscribeUrl(cfg, leadId);
    const { text, html } = composeEmail(cfg, body, unsubUrl);
    let result: SendResult;
    try {
      result = await sender.send({
        from: cfg.emailFrom,
        to: lead.email!,
        subject,
        text,
        html,
        unsubscribeUrl: unsubUrl,
        leadId,
        campaignId: campaignId ?? null,
        idempotencyKey: opts.idempotencyKey,
      });
    } catch (err) {
      const message = err instanceof EmailProviderError ? err.message : `Email send failed: ${err instanceof Error ? err.message : String(err)}`;
      const failed = crm.recordCommunication({
        leadId, draftId: opts.draftId ?? null, campaignId: campaignId ?? null, direction: "OUTBOUND", channel: "EMAIL",
        provider: sender.provider, recipient: lead.email, sender: cfg.emailFrom, subject, body: text, status: "FAILED", error: message,
      });
      crm.logEvent(leadId, "email.failed", message);
      throw new ProviderSendError(message, sender.provider, err instanceof EmailProviderError ? err.code : null, failed.id);
    }

    const sentAt = now().toISOString();
    const communication = crm.tx(() => {
      const c = crm.recordCommunication({
        leadId,
        draftId: opts.draftId ?? null,
        campaignId: campaignId ?? null,
        direction: "OUTBOUND",
        channel: "EMAIL",
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        idempotencyKey: opts.idempotencyKey ?? null,
        recipient: lead.email,
        sender: cfg.emailFrom,
        subject,
        body: text,
        status: "SENT",
        sentAt,
      });
      crm.markContacted(leadId, "EMAIL", sentAt);
      crm.logEvent(leadId, "email.sent", `${result.provider} ${result.providerMessageId ?? ""}`.trim());
      return c;
    });
    return { communication, lead: crm.getLead(leadId)!, dryRun: result.provider === "DRY_RUN", duplicate: false };
  });
}

// ---------- webhooks ----------

/** Apply a verified Resend webhook event. Inbound replies (email.received) are handled by the caller. */
export function handleResendEvent(crm: CRM, evt: { type?: string; data?: Record<string, unknown> }): boolean {
  const data = evt.data ?? {};
  const id = String(data.email_id ?? data.id ?? "");
  if (!id) return false;
  switch (evt.type) {
    case "email.sent":
      return applyDeliveryUpdate(crm, { provider: "RESEND", providerMessageId: id, update: "SENT" });
    case "email.delivered":
      return applyDeliveryUpdate(crm, { provider: "RESEND", providerMessageId: id, update: "DELIVERED" });
    case "email.bounced":
      return applyDeliveryUpdate(crm, { provider: "RESEND", providerMessageId: id, update: "BOUNCED", error: describeBounce(data.bounce) });
    case "email.complained":
      return applyDeliveryUpdate(crm, { provider: "RESEND", providerMessageId: id, update: "COMPLAINED" });
    case "email.failed":
      return applyDeliveryUpdate(crm, { provider: "RESEND", providerMessageId: id, update: "FAILED", error: "Resend reported the send failed" });
    default:
      return false; // opened / clicked / delivery_delayed / scheduled: nothing to do
  }
}

function describeBounce(b: unknown): string {
  if (b && typeof b === "object") {
    const o = b as Record<string, unknown>;
    return [o.type, o.subType, o.message].filter((x) => typeof x === "string" && x).join(": ").slice(0, 300) || "bounced";
  }
  return "bounced";
}
