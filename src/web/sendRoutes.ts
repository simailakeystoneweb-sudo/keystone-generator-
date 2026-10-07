import express, { type Request, type Response } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Pipeline } from "../pipeline.js";
import { ProviderSendError, SendRejectedError } from "../services/errors.js";
import { localOnlyWithoutToken, rateLimit } from "./security.js";

/**
 * Explicit, human-confirmed sends from the Lead Details page. The browser posts
 * the confirmed content here; Resend/Twilio credentials never leave the server.
 * Mounted under /api (DASHBOARD_TOKEN required).
 */
export function createSendRouter(cfg: Config, pipeline: Pipeline): express.Router {
  const r = express.Router();
  // Every route is token/localhost-gated; only the actual sends count toward the send rate limit,
  // so opening the confirmation modal a few times never blocks the send itself.
  const guard = [localOnlyWithoutToken(cfg)];
  const sendGuard = [...guard, rateLimit(cfg.sendRateLimitPerMinute, "send requests")];

  const leadId = (req: Request) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new SendRejectedError("INVALID_INPUT", "invalid lead id");
    if (!pipeline.crm.getLead(id)) throw new SendRejectedError("LEAD_NOT_FOUND", "lead not found");
    return id;
  };

  const IdempotencyKey = z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,100}$/, "idempotencyKey must be 8-100 letters, digits, - or _")
    .optional();

  /** What the confirmation modal shows (recipient, sender, compliance text) and whether sending is allowed. */
  r.get("/leads/:id/send-preview", guard, handle((req) => pipeline.sendPreview(leadId(req))));

  const EmailBody = z.object({
    email: z.string(),
    subject: z.string(),
    body: z.string(),
    campaignId: z.string().optional(),
    idempotencyKey: IdempotencyKey,
  });
  r.post(
    "/leads/:id/email/send",
    sendGuard,
    handle(async (req) => {
      const id = leadId(req);
      const b = EmailBody.parse(req.body ?? {});
      const result = await pipeline.sendEmail(
        { leadId: id, email: b.email, subject: b.subject, body: b.body, campaignId: b.campaignId },
        { idempotencyKey: b.idempotencyKey, draftId: pipeline.crm.latestDraft(id)?.id ?? null },
      );
      return summarize(result);
    }),
  );

  const SmsBody = z.object({
    phone: z.string(),
    message: z.string(),
    campaignId: z.string().optional(),
    idempotencyKey: IdempotencyKey,
  });
  r.post(
    "/leads/:id/sms/send",
    sendGuard,
    handle(async (req) => {
      const id = leadId(req);
      const b = SmsBody.parse(req.body ?? {});
      const result = await pipeline.sendSms(
        { leadId: id, phone: b.phone, message: b.message, campaignId: b.campaignId },
        { idempotencyKey: b.idempotencyKey, draftId: pipeline.crm.latestDraft(id)?.id ?? null },
      );
      return summarize(result);
    }),
  );

  /** Manual contact-preference changes — the only way an opt-out is ever cleared. */
  const Prefs = z
    .object({
      emailOptOut: z.boolean(),
      smsOptOut: z.boolean(),
      doNotContact: z.boolean(),
      smsConsent: z.boolean(),
      sequencePaused: z.boolean(),
    })
    .partial()
    .strict();
  r.patch(
    "/leads/:id/contact-preferences",
    guard,
    handle(async (req) => {
      const id = leadId(req);
      try {
        return pipeline.setContactPreferences(id, Prefs.parse(req.body ?? {}), "dashboard");
      } catch (err) {
        if (err instanceof Error && /cannot record SMS consent/.test(err.message)) throw new SendRejectedError("SMS_OPT_OUT", err.message);
        throw err;
      }
    }),
  );

  return r;
}

function summarize(r: { communication: { id: number; provider: string; providerMessageId: string | null; sentAt: string | null; recipient: string | null }; lead: { status: string; emailStatus: string | null; smsStatus: string | null; lastContactedAt: string | null }; dryRun: boolean; duplicate: boolean }) {
  return {
    communicationId: r.communication.id,
    provider: r.communication.provider,
    providerMessageId: r.communication.providerMessageId,
    recipient: r.communication.recipient,
    sentAt: r.communication.sentAt,
    dryRun: r.dryRun,
    duplicate: r.duplicate,
    lead: { status: r.lead.status, emailStatus: r.lead.emailStatus, smsStatus: r.lead.smsStatus, lastContactedAt: r.lead.lastContactedAt },
  };
}

/** Map errors to safe responses: rejection reasons and provider messages are shown; credentials never are. */
function handle(fn: (req: Request) => Promise<unknown> | unknown) {
  return async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      if (err instanceof SendRejectedError) return void res.status(err.httpStatus).json({ error: err.message, code: err.code });
      if (err instanceof ProviderSendError) {
        return void res.status(502).json({ error: err.message, code: "PROVIDER_ERROR", provider: err.provider, providerCode: err.providerCode });
      }
      if (err instanceof z.ZodError) {
        return void res.status(400).json({ error: "invalid request", code: "INVALID_INPUT", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      }
      console.error("[send] unexpected error:", err);
      res.status(500).json({ error: "internal error" });
    }
  };
}
