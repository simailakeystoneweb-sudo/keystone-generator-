/**
 * Twilio SMS. Server-side only: TWILIO_AUTH_TOKEN is read from the environment
 * here and never sent to the browser.
 *
 * Compliance: we never work around Twilio's opt-out handling. Twilio Advanced
 * Opt-Out replies to STOP/HELP/START itself and blocks texts to opted-out numbers
 * (error 21610); we mirror every opt-out into the CRM permanently, append opt-out
 * instructions to every outreach text, and only a manual change in the dashboard
 * can re-enable SMS for a lead.
 */
import twilio from "twilio";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { CRM } from "../../crm/db.js";
import { composeSms, SmsProviderError, type SmsSender, type SmsMessage } from "../../channels/sms.js";
import type { SendResult } from "../../channels/email.js";
import { localParts } from "../../rules.js";
import type { Communication, Lead, ReplyClassificationRecord } from "../../types.js";
import { applyDeliveryUpdate, type DeliveryUpdate } from "../delivery.js";
import { contactable, notContactable, ProviderSendError, SendRejectedError, withSendLock, type Contactability } from "../errors.js";
import { classifyAndApply, smsKeyword, toRecord, type ReplyClassifier } from "../replies.js";
import { toE164 } from "./phone.js";
import type { SendOptions } from "../email/resend.js";

// ---------- transport ----------

/** The slice of the Twilio client we use (lets tests pass a fake). */
export interface TwilioLike {
  messages: { create(opts: { to: string; body: string; statusCallback?: string; from?: string; messagingServiceSid?: string }): Promise<{ sid: string }> };
}

export class TwilioSmsSender implements SmsSender {
  readonly provider = "TWILIO" as const;
  private client: TwilioLike;

  constructor(private opts: { accountSid?: string; authToken?: string; phoneNumber?: string; messagingServiceSid?: string; client?: TwilioLike }) {
    if (!opts.client && (!opts.accountSid || !opts.authToken)) throw new Error("Twilio needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN");
    if (!opts.phoneNumber && !opts.messagingServiceSid) throw new Error("Twilio needs TWILIO_PHONE_NUMBER (or TWILIO_MESSAGING_SERVICE_SID)");
    this.client = opts.client ?? (twilio(opts.accountSid, opts.authToken) as unknown as TwilioLike);
  }

  get from(): string {
    return this.opts.phoneNumber ?? "";
  }

  async send(msg: SmsMessage): Promise<SendResult> {
    try {
      const m = await this.client.messages.create({
        to: msg.to,
        body: msg.body,
        statusCallback: msg.statusCallback,
        ...(this.opts.messagingServiceSid ? { messagingServiceSid: this.opts.messagingServiceSid } : { from: this.opts.phoneNumber }),
      });
      return { provider: this.provider, providerMessageId: m.sid };
    } catch (err) {
      const e = err as { message?: string; code?: number; status?: number };
      throw new SmsProviderError(e.message || "Twilio rejected the message", typeof e.code === "number" ? e.code : null, typeof e.status === "number" ? e.status : null);
    }
  }
}

/** Twilio error codes we act on. */
export const TWILIO_UNSUBSCRIBED_RECIPIENT = 21610; // recipient replied STOP; Twilio blocks the send
const TWILIO_INVALID_NUMBER_CODES = new Set([21211, 21614, 21217]);

// ---------- sendLeadSMS ----------

export const SendLeadSmsInput = z.object({
  leadId: z.number().int().positive(),
  phone: z.string().trim().min(1, "phone is required").max(40),
  message: z.string().trim().min(1, "message is required").max(1500),
  campaignId: z.string().trim().min(1).max(100).optional(),
});
export type SendLeadSmsInput = z.input<typeof SendLeadSmsInput>;

export interface LeadSmsDeps {
  crm: CRM;
  cfg: Config;
  sender: SmsSender | null;
  now?: () => Date;
}

export interface SendLeadSmsResult {
  communication: Communication;
  lead: Lead;
  dryRun: boolean;
  duplicate: boolean;
}

export function inQuietHours(now: Date, cfg: Config): boolean {
  const { hour } = localParts(now, cfg.rules.timezone);
  const { smsQuietHoursStart: start, smsQuietHoursEnd: end } = cfg;
  if (start === end) return false;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

/** Can this lead be texted right now? Checked before every send (and shown in the confirmation modal). */
export function checkSmsContactable(crm: CRM, cfg: Config, lead: Lead, now: Date): Contactability {
  const phone = toE164(lead.phone);
  if (!phone) return notContactable("INVALID_PHONE", lead.phone ? `"${lead.phone}" isn't a valid phone number.` : "This lead has no phone number.");
  if (lead.smsOptOut) return notContactable("SMS_OPT_OUT", "This lead has opted out of SMS.");
  if (lead.doNotContact) return notContactable("DO_NOT_CONTACT", "This lead is marked do not contact.");
  if (crm.isSuppressed(phone)) return notContactable("SUPPRESSED", "This number is on the suppression list (it texted STOP).");
  if (cfg.rules.smsRequireConsent && !lead.smsConsent) {
    return notContactable("NO_SMS_CONSENT", "No SMS consent is recorded for this lead (required to text them).");
  }
  if (inQuietHours(now, cfg)) {
    return notContactable("QUIET_HOURS", `It's quiet hours (${cfg.smsQuietHoursStart}:00–${cfg.smsQuietHoursEnd}:00 ${cfg.rules.timezone}); texts can't be sent now.`);
  }
  return contactable();
}

/**
 * Send one SMS to a lead through Twilio and record it.
 *
 * Before sending: loads the lead, confirms the number is valid (E.164) and is the
 * lead's own, and that the lead isn't opted out of SMS, marked do-not-contact,
 * suppressed, missing consent, or inside quiet hours. Any failure rejects with
 * SendRejectedError and nothing is sent.
 *
 * After sending: records an OUTBOUND / SMS / TWILIO communication with
 * provider_message_id, body and sent_at, and updates the lead
 * (sms_status = SENT, last_contacted_at = now, status → contacted on first contact).
 */
export async function sendLeadSMS(input: SendLeadSmsInput, deps: LeadSmsDeps, opts: SendOptions = {}): Promise<SendLeadSmsResult> {
  const parsed = SendLeadSmsInput.safeParse(input);
  if (!parsed.success) {
    throw new SendRejectedError("INVALID_INPUT", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  }
  const { leadId, phone, message, campaignId } = parsed.data;
  const { crm, cfg, sender } = deps;
  const now = deps.now ?? (() => new Date());

  if (opts.idempotencyKey) {
    const prior = crm.findCommunicationByIdempotencyKey(opts.idempotencyKey);
    if (prior) {
      if (prior.leadId !== leadId || prior.channel !== "SMS") throw new SendRejectedError("INVALID_INPUT", "idempotency key was already used for a different send");
      return { communication: prior, lead: crm.getLead(leadId)!, dryRun: prior.provider === "DRY_RUN", duplicate: true };
    }
  }

  // 1. Load the lead.
  const lead = crm.getLead(leadId);
  if (!lead) throw new SendRejectedError("LEAD_NOT_FOUND", `Lead ${leadId} not found.`);
  // 2. Valid phone number, and it's this lead's number.
  const to = toE164(phone);
  if (!to) throw new SendRejectedError("INVALID_PHONE", `"${phone}" isn't a valid phone number.`);
  // 3-4. Not opted out of SMS, not do-not-contact (+ suppression, consent, quiet hours).
  const check = checkSmsContactable(crm, cfg, lead, now());
  if (!check.ok) throw new SendRejectedError(check.code!, check.message);
  if (to !== toE164(lead.phone)) throw new SendRejectedError("PHONE_MISMATCH", "That phone number doesn't match this lead's number.");
  if (!sender) throw new SendRejectedError("NOT_CONFIGURED", "SMS sending is not configured (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER).");

  const body = composeSms(message);
  if (body.length > 1600) throw new SendRejectedError("INVALID_INPUT", "message is too long (max 1600 characters including opt-out text)");
  const from = sender instanceof TwilioSmsSender ? sender.from : cfg.twilioPhoneNumber;

  return withSendLock(crm, `sms:${leadId}`, async () => {
    let result: SendResult;
    try {
      result = await sender.send({ from, to, body, statusCallback: `${cfg.publicBaseUrl}/api/webhooks/twilio/status`, leadId });
    } catch (err) {
      const code = err instanceof SmsProviderError ? err.code : null;
      const msg = err instanceof Error ? err.message : String(err);
      const failed = crm.recordCommunication({
        leadId, draftId: opts.draftId ?? null, campaignId: campaignId ?? null, direction: "OUTBOUND", channel: "SMS",
        provider: sender.provider, recipient: to, sender: from || null, body, status: "FAILED", error: code ? `Twilio ${code}: ${msg}` : msg,
      });
      crm.logEvent(leadId, "sms.failed", code ? `Twilio ${code}: ${msg}` : msg);
      if (code === TWILIO_UNSUBSCRIBED_RECIPIENT) {
        // Twilio knows this number replied STOP. Mirror it permanently.
        crm.optOut(leadId, { sms: true }, "Twilio reports the recipient has opted out (error 21610)");
        throw new SendRejectedError("SMS_OPT_OUT", "This number has opted out of texts from us (Twilio 21610). It's now marked SMS opt-out.");
      }
      if (code !== null && TWILIO_INVALID_NUMBER_CODES.has(code)) {
        throw new ProviderSendError(`Twilio says this isn't a textable number (${code}).`, sender.provider, code, failed.id);
      }
      throw new ProviderSendError(code ? `Twilio error ${code}: ${msg}` : msg, sender.provider, code, failed.id);
    }

    const sentAt = now().toISOString();
    const communication = crm.tx(() => {
      const c = crm.recordCommunication({
        leadId,
        draftId: opts.draftId ?? null,
        campaignId: campaignId ?? null,
        direction: "OUTBOUND",
        channel: "SMS",
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        idempotencyKey: opts.idempotencyKey ?? null,
        recipient: to,
        sender: from || null,
        body,
        status: "SENT",
        sentAt,
      });
      crm.markContacted(leadId, "SMS", sentAt);
      crm.logEvent(leadId, "sms.sent", `${result.provider} ${result.providerMessageId ?? ""}`.trim());
      return c;
    });
    return { communication, lead: crm.getLead(leadId)!, dryRun: result.provider === "DRY_RUN", duplicate: false };
  });
}

// ---------- webhooks ----------

/** Verify X-Twilio-Signature with the official SDK helper. `url` must be the exact public URL Twilio called. */
export function validateTwilioWebhook(authToken: string, signature: string | undefined, url: string, params: Record<string, string>): boolean {
  if (!authToken || !signature) return false;
  return twilio.validateRequest(authToken, signature, url, params);
}

export interface IncomingSms {
  From?: string;
  To?: string;
  Body?: string;
  MessageSid?: string;
}

export type IncomingKind = "opt_out" | "opt_in_request" | "help" | "reply" | "duplicate" | "unknown_sender" | "invalid";

export interface IncomingResult {
  kind: IncomingKind;
  leadId: number | null;
  communicationId: number | null;
  /** Resolves once Claude has classified the reply (null if not classified). The webhook doesn't wait for it. */
  classification: Promise<ReplyClassificationRecord | null>;
}

/**
 * POST /api/webhooks/twilio/incoming
 *  1. Receive From, To, Body.  2. Normalize the phone number.  3. Find the lead.
 *  4. Record an INBOUND communication.  5. Mark replied.  6. Pause the sequence.
 * STOP-style keywords set sms_opt_out (permanently). Everything else is classified
 * by Claude and the classification is stored.
 */
export function handleIncomingSms(
  params: IncomingSms,
  deps: { crm: CRM; classify: ReplyClassifier | null; now?: () => Date },
): IncomingResult {
  const { crm, classify } = deps;
  const now = deps.now ?? (() => new Date());
  const none = Promise.resolve(null);
  const text = String(params.Body ?? "").slice(0, 5000);
  const from = toE164(params.From) ?? null;
  const sid = params.MessageSid ? String(params.MessageSid) : null;
  if (!from) return { kind: "invalid", leadId: null, communicationId: null, classification: none };

  // Twilio retries webhooks; process each MessageSid once.
  if (sid && crm.findCommunicationByProviderId("TWILIO", sid)) return { kind: "duplicate", leadId: null, communicationId: null, classification: none };

  const keyword = smsKeyword(text);
  const lead = crm.findLeadByPhone(from);
  if (!lead) {
    // Honour STOP even from numbers we don't know yet, so a later import can't text them.
    if (keyword === "OPT_OUT") {
      crm.suppress(from, "SMS STOP from unknown number");
      crm.logEvent(null, "sms.opt_out_unknown", from);
    }
    return { kind: "unknown_sender", leadId: null, communicationId: null, classification: none };
  }

  const receivedAt = now().toISOString();
  const comm = crm.tx(() => {
    const c = crm.recordCommunication({
      leadId: lead.id,
      direction: "INBOUND",
      channel: "SMS",
      provider: "TWILIO",
      providerMessageId: sid,
      recipient: params.To ? String(params.To) : null,
      sender: from,
      body: text,
      status: "RECEIVED",
      sentAt: receivedAt,
    });
    crm.markReplied(lead.id);
    crm.logEvent(lead.id, "sms.received", text.slice(0, 120));
    return c;
  });

  const storeKeyword = (rec: ReplyClassificationRecord) => {
    crm.setCommunicationClassification(comm.id, rec);
    crm.setLastReplyClassification(lead.id, rec);
    return Promise.resolve(rec);
  };

  if (keyword === "OPT_OUT") {
    crm.optOut(lead.id, { sms: true }, `texted "${text.trim().slice(0, 20)}"`);
    const rec = toRecord(
      {
        classification: "UNSUBSCRIBE",
        sentiment: "NEGATIVE",
        recommendedAction: "Opted out of SMS. Never text this number again; Twilio has also blocked it.",
        shouldPauseSequence: true,
      },
      "keyword",
      now(),
    );
    return { kind: "opt_out", leadId: lead.id, communicationId: comm.id, classification: storeKeyword(rec) };
  }

  if (keyword === "OPT_IN" && (lead.smsOptOut || crm.isSuppressed(from))) {
    // Twilio re-enables delivery at the carrier level, but our opt-out is permanent until
    // someone confirms consent and re-enables SMS manually.
    crm.logEvent(lead.id, "sms.opt_in_request", "Lead texted START. SMS stays opted out until it's re-enabled manually.");
    const rec = toRecord(
      {
        classification: "OPT_IN_REQUEST",
        sentiment: "NEUTRAL",
        recommendedAction: "Lead texted START. Confirm they want texts before re-enabling SMS on the lead page.",
        shouldPauseSequence: true,
      },
      "keyword",
      now(),
    );
    return { kind: "opt_in_request", leadId: lead.id, communicationId: comm.id, classification: storeKeyword(rec) };
  }

  if (keyword === "HELP") {
    crm.setStatus(lead.id, "replied", "texted HELP");
    const rec = toRecord(
      {
        classification: "QUESTION",
        sentiment: "NEUTRAL",
        recommendedAction: "Lead texted HELP (Twilio sent the standard help reply). Follow up personally if appropriate.",
        shouldPauseSequence: true,
      },
      "keyword",
      now(),
    );
    return { kind: "help", leadId: lead.id, communicationId: comm.id, classification: storeKeyword(rec) };
  }

  const classification = classifyAndApply({ crm, lead, channel: "sms", text, communicationId: comm.id, classify, now });
  return { kind: "reply", leadId: lead.id, communicationId: comm.id, classification };
}

/** POST /api/webhooks/twilio/status — message status callbacks. */
export function handleTwilioStatus(crm: CRM, params: { MessageSid?: string; MessageStatus?: string; ErrorCode?: string }): boolean {
  const sid = String(params.MessageSid ?? "");
  const status = String(params.MessageStatus ?? "").toLowerCase();
  const map: Record<string, DeliveryUpdate> = { sent: "SENT", delivered: "DELIVERED", read: "DELIVERED", undelivered: "UNDELIVERED", failed: "FAILED" };
  if (!sid || !map[status]) return false;
  const errorCode = params.ErrorCode ? Number(params.ErrorCode) : null;
  const ok = applyDeliveryUpdate(crm, { provider: "TWILIO", providerMessageId: sid, update: map[status], error: errorCode ? `Twilio error ${errorCode}` : null });
  if (ok && errorCode === TWILIO_UNSUBSCRIBED_RECIPIENT) {
    const comm = crm.findCommunicationByProviderId("TWILIO", sid);
    if (comm) crm.optOut(comm.leadId, { sms: true }, "Twilio reports the recipient has opted out (error 21610)");
  }
  return ok;
}
