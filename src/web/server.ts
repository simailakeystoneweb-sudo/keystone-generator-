import express, { type NextFunction, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type { Pipeline } from "../pipeline.js";
import { verifyResendWebhook } from "../channels/email.js";
import { verifyTwilioSignature } from "../channels/sms.js";
import type { LeadStatus } from "../types.js";
import { PIPELINE, SIDE_STAGES } from "../types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp(cfg: Config, pipeline: Pipeline): express.Express {
  const app = express();
  const crm = pipeline.crm;
  app.set("trust proxy", true);

  // ---------- webhooks (provider-authenticated, registered before body parsers that would consume the stream) ----------

  /** Resend: email.sent / delivered / bounced / complained / received. Signed with Svix. */
  app.post("/webhooks/resend", express.text({ type: "*/*", limit: "1mb" }), async (req, res) => {
    const raw = typeof req.body === "string" ? req.body : "";
    if (cfg.resendWebhookSecret) {
      const ok = verifyResendWebhook(
        cfg.resendWebhookSecret,
        { id: req.header("svix-id"), timestamp: req.header("svix-timestamp"), signature: req.header("svix-signature") },
        raw,
      );
      if (!ok) return void res.status(401).json({ error: "bad signature" });
    } else if (!cfg.dryRun) {
      return void res.status(503).json({ error: "RESEND_WEBHOOK_SECRET not configured" });
    }
    let evt: { type?: string; data?: Record<string, unknown> };
    try {
      evt = JSON.parse(raw);
    } catch {
      return void res.status(400).json({ error: "invalid json" });
    }
    const data = evt.data ?? {};
    const id = String(data.email_id ?? data.id ?? "");
    switch (evt.type) {
      case "email.delivered":
        pipeline.handleDeliveryEvent("resend", id, "delivered");
        break;
      case "email.bounced":
        pipeline.handleDeliveryEvent("resend", id, "bounced", JSON.stringify(data.bounce ?? "bounced"));
        break;
      case "email.complained":
        pipeline.handleDeliveryEvent("resend", id, "complained");
        break;
      case "email.received": {
        // Inbound email routed to your Resend receiving domain.
        const from = String(data.from ?? "");
        const text = String(data.text ?? data.subject ?? "");
        if (from && text) await pipeline.handleInbound("email", from, text, "resend", id || null);
        break;
      }
      default:
        break; // sent/opened/clicked/delivery_delayed: nothing to do
    }
    res.json({ ok: true });
  });

  const twilioAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!cfg.twilioValidateSignature || cfg.dryRun) return next();
    const url = `${cfg.publicBaseUrl}${req.originalUrl}`;
    if (!verifyTwilioSignature(cfg.twilioAuthToken, url, req.body as Record<string, string>, req.header("x-twilio-signature"))) {
      return void res.status(403).send("bad signature");
    }
    next();
  };
  const form = express.urlencoded({ extended: false });

  /** Twilio message status callback: queued → sent → delivered | undelivered | failed. */
  app.post("/webhooks/twilio/status", form, twilioAuth, (req, res) => {
    const sid = String(req.body.MessageSid ?? "");
    const st = String(req.body.MessageStatus ?? "");
    const map: Record<string, "sent" | "delivered" | "failed"> = { sent: "sent", delivered: "delivered", undelivered: "failed", failed: "failed" };
    if (sid && map[st]) pipeline.handleDeliveryEvent("twilio", sid, map[st], req.body.ErrorCode ? `Twilio error ${req.body.ErrorCode}` : undefined);
    res.sendStatus(204);
  });

  /** Twilio inbound SMS (set as the number's "A message comes in" webhook). */
  app.post("/webhooks/twilio/inbound", form, twilioAuth, async (req, res) => {
    const from = String(req.body.From ?? "");
    const body = String(req.body.Body ?? "");
    if (from && body) await pipeline.handleInbound("sms", from, body, "twilio", String(req.body.MessageSid ?? "") || null);
    res.type("text/xml").send("<Response></Response>");
  });

  /** Generic inbound email hook (Gmail Apps Script, Zapier, Mailgun routes, etc.): {from, text}. */
  app.post("/webhooks/email/inbound", express.json({ limit: "1mb" }), requireToken(cfg), async (req, res) => {
    const { from, text } = req.body ?? {};
    if (!from || !text) return void res.status(400).json({ error: "from and text are required" });
    const r = await pipeline.handleInbound("email", String(from), String(text), "inbound-hook");
    res.json({ matched: Boolean(r.lead), intent: r.intent, leadId: r.lead?.id ?? null });
  });

  // ---------- unsubscribe (public, token-signed; supports RFC 8058 one-click POST) ----------

  const unsub = (req: Request, res: Response) => {
    const ok = pipeline.unsubscribe(Number(req.params.id), String(req.params.token));
    res
      .status(ok ? 200 : 400)
      .type("html")
      .send(
        `<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:40px;text-align:center">` +
          (ok ? "<h2>You're unsubscribed.</h2><p>You won't hear from us again.</p>" : "<h2>Invalid unsubscribe link.</h2>") +
          `</body>`,
      );
  };
  app.get("/unsubscribe/:id/:token", unsub);
  app.post("/unsubscribe/:id/:token", unsub);

  // ---------- dashboard + API ----------

  app.get("/", (_req, res) => {
    res.type("html").send(readFileSync(path.join(here, "dashboard.html"), "utf8"));
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
    res.json({ ...lead, draft: crm.latestDraft(id), messages: crm.messagesForLead(id), events: crm.eventsForLead(id) });
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
  api.post("/leads/:id/send", wrap(async (req) => {
    const id = Number(req.params.id);
    return { email: await pipeline.trySend(id, "email"), sms: await pipeline.trySend(id, "sms") };
  }));
  api.post("/run", wrap((req) => pipeline.runAll({ send: req.body?.send !== false })));
  api.post("/send-due", wrap(() => pipeline.sendDue()));

  app.use("/api", api);
  return app;
}

function requireToken(cfg: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!cfg.dashboardToken) return next(); // no token set: local-only use
    const header = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (header && safeEqual(header, cfg.dashboardToken)) return next();
    res.status(401).json({ error: "unauthorized" });
  };
}
