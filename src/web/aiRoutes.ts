import express, { type Request, type Response } from "express";
import { localOnlyWithoutToken, rateLimit } from "./security.js";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Pipeline } from "../pipeline.js";
import {
  AnalyzeLeadInput,
  ClassifyReplyInput,
  ClaudeNotConfiguredError,
  ClaudeOutputError,
  FollowUpInput,
  GenerateMessageInput,
  type ClaudeService,
} from "../ai/claude.js";

/**
 * AI endpoints. These run only on the server: the browser posts lead data here,
 * the server calls Claude with the server-held ANTHROPIC_API_KEY, and only the
 * generated JSON comes back. None of these routes send email or SMS.
 */
export function createAiRouter(cfg: Config, pipeline: Pipeline, claude: ClaudeService | null): express.Router {
  const r = express.Router();
  r.use(localOnlyWithoutToken(cfg), rateLimit(cfg.aiRateLimitPerMinute, "AI requests"));

  const svc = () => {
    if (!claude?.configured) throw new ClaudeNotConfiguredError();
    return claude;
  };
  const leadId = (req: Request) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "invalid lead id");
    if (!pipeline.crm.getLead(id)) throw new HttpError(404, "lead not found");
    return id;
  };

  r.get("/status", (_req, res) => {
    res.json({ configured: Boolean(claude?.configured), model: cfg.anthropicModel });
  });

  // ---- stateless: pass lead data in, get JSON back ----
  r.post("/analyze-lead", handle((req) => svc().analyzeLead(AnalyzeLeadInput.parse(req.body))));
  r.post("/generate-cold-email", handle((req) => svc().generateColdEmail(GenerateMessageInput.parse(req.body))));
  r.post("/generate-cold-sms", handle((req) => svc().generateColdSMS(GenerateMessageInput.parse(req.body))));
  r.post("/generate-follow-up", handle((req) => svc().generateFollowUp(FollowUpInput.parse(req.body))));
  r.post("/classify-reply", handle((req) => svc().classifyReply(ClassifyReplyInput.parse(req.body))));

  // ---- lead-bound: read the lead from the CRM, save the result for review (never sent) ----
  const AnalyzeOverrides = AnalyzeLeadInput.pick({ description: true, notes: true, knownWebsiteIssues: true }).partial();
  r.post(
    "/leads/:id/analyze",
    handle(async (req) => {
      const id = leadId(req);
      svc();
      const body = AnalyzeOverrides.parse(req.body ?? {});
      // Only pass fields the user actually sent, so stored values aren't blanked by zod defaults.
      const sent = (k: string) => req.body && Object.prototype.hasOwnProperty.call(req.body, k);
      return pipeline.analyzeLead(id, {
        description: sent("description") ? body.description : undefined,
        notes: sent("notes") ? body.notes : undefined,
        knownWebsiteIssues: sent("knownWebsiteIssues") ? body.knownWebsiteIssues : undefined,
      });
    }),
  );
  r.post("/leads/:id/email", handle(async (req) => (svc(), pipeline.generateEmail(leadId(req)))));
  r.post("/leads/:id/sms", handle(async (req) => (svc(), pipeline.generateSms(leadId(req)))));
  r.post(
    "/leads/:id/follow-up",
    handle(async (req) => {
      const { channel } = z.object({ channel: z.enum(["EMAIL", "SMS"]).default("EMAIL") }).parse(req.body ?? {});
      return (svc(), pipeline.generateFollowUp(leadId(req), channel));
    }),
  );
  r.post(
    "/leads/:id/classify-reply",
    handle(async (req) => {
      const body = z.object({ replyText: z.string().trim().min(1).max(10000), channel: z.enum(["email", "sms"]).default("email") }).parse(req.body ?? {});
      return (svc(), pipeline.classifyLeadReply(leadId(req), body.replyText, body.channel));
    }),
  );

  return r;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Map errors to safe client responses. Provider error details stay in the server log. */
function handle(fn: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
      if (err instanceof z.ZodError) {
        return void res.status(400).json({ error: "invalid request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      }
      if (err instanceof ClaudeNotConfiguredError) return void res.status(503).json({ error: err.message });
      if (err instanceof ClaudeOutputError) return void res.status(502).json({ error: err.message });
      if (err instanceof Anthropic.RateLimitError) return void res.status(429).json({ error: "Claude is rate limited right now; try again shortly." });
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        console.error("[ai] Anthropic auth error — check ANTHROPIC_API_KEY:", err.status);
        return void res.status(502).json({ error: "The server's Claude credentials were rejected." });
      }
      if (err instanceof Anthropic.APIError) {
        console.error("[ai] Anthropic API error:", err.status, err.message);
        return void res.status(502).json({ error: "Claude request failed; try again." });
      }
      if (err instanceof Error && /not found|not configured/i.test(err.message)) return void res.status(400).json({ error: err.message });
      console.error("[ai] unexpected error:", err);
      res.status(500).json({ error: "internal error" });
    }
  };
}
