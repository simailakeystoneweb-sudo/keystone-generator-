import express, { type NextFunction, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Config } from "../config.js";
import type { Pipeline } from "../pipeline.js";
import type { ClaudeService } from "../ai/claude.js";
import { createAiRouter } from "./aiRoutes.js";
import { createSendRouter } from "./sendRoutes.js";
import { requireToken } from "./security.js";
import { verifyResendWebhook } from "../channels/email.js";
import { handleResendEvent } from "../services/email/resend.js";
import { handleTwilioStatus, validateTwilioWebhook } from "../services/sms/twilio.js";
import type { LeadStatus } from "../types.js";
import { PIPELINE, SIDE_STAGES } from "../types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Log (never throw from) background reply classification started by a webhook. */
const background = (what: string, p: Promise<unknown>) => p.catch((err) => console.error(`[${what}]`, err));

export function createApp(cfg: Config, pipeline: Pipeline, claude: ClaudeService | null = null): express.Express {
  const app = express();
  const crm = pipeline.crm;
  // Only trust X-Forwarded-* when explicitly behind a proxy; otherwise clients could spoof their IP.
  app.set("trust proxy", cfg.trustProxy ? 1 : false);
  app.disable("x-powered-by");

  // ---------- webhooks (provider-authenticated, registered before body parsers that would consume the stream) ----------

  /** Resend: email.sent / delivered / bounced / complained / failed / received. Signed with Svix. */
  app.post("/webhooks/resend", express.text({ type: "*/*", limit: "1mb" }), (req, res) => {
    const raw = typeof req.body === "string" ? req.body : "";
    // Always verify: an unsigned endpoint would let anyone mark leads bounced or opted out.
    if (!cfg.resendWebhookSecret) return void res.status(503).json({ error: "RESEND_WEBHOOK_SECRET not configured" });
    const ok = verifyResendWebhook(
      cfg.resendWebhookSecret,
      { id: req.header("svix-id"), timestamp: req.header("svix-timestamp"), signature: req.header("svix-signature") },
      raw,
    );
    if (!ok) return void res.status(401).json({ error: "bad signature" });
    let evt: { type?: string; data?: Record<string, unknown> };
    try {
      evt = JSON.parse(raw);
    } catch {
      return void res.status(400).json({ error: "invalid json" });
    }
    if (evt.type === "email.received") {
      // Inbound email routed to your Resend receiving domain.
      const data = evt.data ?? {};
      const from = String(data.from ?? "");
      const text = String(data.text ?? data.subject ?? "");
      const id = String(data.email_id ?? data.id ?? "") || null;
      if (from && text) background("resend-inbound", pipeline.handleInboundEmail(from, text, "RESEND", id, data.subject ? String(data.subject) : null).classification);
    } else {
      handleResendEvent(crm, evt);
    }
    res.json({ ok: true });
  });

  /**
   * Twilio signs every webhook with X-Twilio-Signature over the exact public URL it
   * called, so PUBLIC_BASE_URL must match the URL configured in Twilio.
   * TWILIO_VALIDATE_SIGNATURE=false disables this for local testing only.
   */
  const twilioAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!cfg.twilioValidateSignature) return next();
    if (!cfg.twilioAuthToken) return void res.status(503).type("text/plain").send("TWILIO_AUTH_TOKEN not configured");
    const url = `${cfg.publicBaseUrl}${req.originalUrl}`;
    if (!validateTwilioWebhook(cfg.twilioAuthToken, req.header("x-twilio-signature"), url, req.body as Record<string, string>)) {
      return void res.status(403).type("text/plain").send("bad signature");
    }
    next();
  };
  const form = express.urlencoded({ extended: false, limit: "64kb" });

  /** Twilio message status callback: queued → sent → delivered | undelivered | failed. */
  const twilioStatus = (req: Request, res: Response) => {
    handleTwilioStatus(crm, req.body ?? {});
    res.sendStatus(204);
  };

  /**
   * Twilio inbound SMS ("A message comes in" webhook). Responds right away with empty
   * TwiML — Twilio Advanced Opt-Out sends the STOP/HELP/START replies itself, and we
   * never send our own auto-reply. Claude classification continues in the background.
   */
  const twilioIncoming = (req: Request, res: Response) => {
    const r = pipeline.handleIncomingSms({ From: req.body?.From, To: req.body?.To, Body: req.body?.Body, MessageSid: req.body?.MessageSid });
    background("twilio-incoming", r.classification);
    res.type("text/xml").send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
  };

  app.post("/api/webhooks/twilio/incoming", form, twilioAuth, twilioIncoming);
  app.post("/api/webhooks/twilio/status", form, twilioAuth, twilioStatus);
  // Older URLs, kept so existing Twilio configuration keeps working.
  app.post("/webhooks/twilio/inbound", form, twilioAuth, twilioIncoming);
  app.post("/webhooks/twilio/status", form, twilioAuth, twilioStatus);

  /** Generic inbound email hook (Gmail Apps Script, Zapier, Mailgun routes, etc.): {from, text, subject?}. */
  app.post("/webhooks/email/inbound", express.json({ limit: "1mb" }), requireToken(cfg), (req, res) => {
    const { from, text, subject } = req.body ?? {};
    if (!from || !text) return void res.status(400).json({ error: "from and text are required" });
    const r = pipeline.handleInboundEmail(String(from), String(text), "INBOUND_HOOK", null, subject ? String(subject) : null);
    background("email-inbound", r.classification);
    res.json({ matched: Boolean(r.lead), leadId: r.lead?.id ?? null, communicationId: r.communicationId });
  });

  // ---------- unsubscribe (public, token-signed; supports RFC 8058 one-click POST) ----------

  const unsub = (req: Request, res: Response) => {
    const ok = pipeline.unsubscribe(Number(req.params.id), String(req.params.token));
    res
      .status(ok ? 200 : 400)
      .type("html")
      .send(
        `<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:40px;text-align:center">` +
          (ok ? "<h2>You're unsubscribed.</h2><p>You won't receive any more emails from us.</p>" : "<h2>Invalid unsubscribe link.</h2>") +
          `</body>`,
      );
  };
  app.get("/unsubscribe/:id/:token", unsub);
  app.post("/unsubscribe/:id/:token", unsub);

  // ---------- dashboard + API ----------

  app.get("/", (_req, res) => {
    res.type("html").send(readFileSync(path.join(here, "dashboard.html"), "utf8"));
  });
  app.get("/leads/:id", (_req, res) => {
    res.type("html").send(readFileSync(path.join(here, "lead.html"), "utf8"));
  });

  const api = express.Router();
  api.use(express.json({ limit: "256kb" }), requireToken(cfg));

  api.get("/stats", (_req, res) => {
    res.json({ ...crm.stats(), dryRun: cfg.dryRun, approvalMode: cfg.rules.approvalMode, stages: [...PIPELINE, ...SIDE_STAGES] });
  });

  api.get("/leads", (req, res) => {
    const status = typeof req.query.status === "string" && req.query.status ? (req.query.status.split(",") as LeadStatus[]) : undefined;
    const leads = crm.listLeads({ status, limit: Number(req.query.limit ?? 500) });
    res.json(leads.map((l) => ({ ...l, draft: crm.latestDraft(l.id) })));
  });

  api.get("/leads/:id", (req, res) => {
    const id = Number(req.params.id);
    const lead = crm.getLead(id);
    if (!lead) return void res.status(404).json({ error: "not found" });
    res.json({ ...lead, draft: crm.latestDraft(id), communications: crm.communicationsForLead(id), events: crm.eventsForLead(id) });
  });

  const wrap = (fn: (req: Request) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  api.post("/find", wrap(async (req) => {
    const { industry, city, limit } = req.body ?? {};
    if (!industry || !city) throw new Error("industry and city are required");
    const r = await pipeline.findLeads({ industry, city, limit: Number(limit) || 20 });
    return { found: r.found, created: r.created.length };
  }));
  api.post("/leads/:id/enrich", wrap((req) => pipeline.enrich(Number(req.params.id))));
  api.post("/leads/:id/draft", wrap((req) => pipeline.draft(Number(req.params.id))));
  api.post("/leads/:id/redraft", wrap((req) => pipeline.redraft(Number(req.params.id))));
  api.post("/leads/:id/approve", wrap((req) => pipeline.approve(Number(req.params.id), req.body ?? {}, "dashboard")));
  api.post("/leads/:id/reject", wrap((req) => pipeline.reject(Number(req.params.id), req.body?.reason ?? "rejected", "dashboard")));
  api.post("/leads/:id/stage", wrap((req) => pipeline.markStage(Number(req.params.id), req.body.stage, req.body.note)));
  api.post("/run", wrap((req) => pipeline.runAll({ send: req.body?.send !== false })));
  api.post("/send-due", wrap(() => pipeline.sendDue()));

  /** Save hand edits to the latest draft. Does not approve or send it. */
  api.put("/leads/:id/draft", wrap((req) => {
    const id = Number(req.params.id);
    if (!crm.getLead(id)) throw new Error("lead not found");
    const pick = (k: string) => (typeof req.body?.[k] === "string" ? String(req.body[k]).slice(0, 10000) : undefined);
    const patch = { emailSubject: pick("emailSubject"), emailBody: pick("emailBody"), smsBody: pick("smsBody") };
    const draft = crm.latestDraft(id);
    if (draft) return crm.updateDraft(draft.id, patch);
    return crm.saveDraft(id, { emailSubject: patch.emailSubject ?? "", emailBody: patch.emailBody ?? "", smsBody: patch.smsBody ?? "", reasoning: "" });
  }));

  // Claude endpoints (server-side only; behind the same token as the rest of the API).
  api.use("/ai", createAiRouter(cfg, pipeline, claude));
  // Email/SMS sending (Resend/Twilio keys stay on the server) + contact preferences.
  api.use(createSendRouter(cfg, pipeline));

  app.use("/api", api);
  return app;
}
