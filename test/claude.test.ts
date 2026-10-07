import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { ClaudeNotConfiguredError, ClaudeOutputError, ClaudeService, type ClaudeClient } from "../src/ai/claude.js";
import { createApp } from "../src/web/server.js";
import { makePipeline, testConfig } from "./helpers.js";

const agency = { agencyName: "Keystone Web Agency", senderName: "Alex", senderTitle: "Founder", offer: "Websites", bookingUrl: "" };

/** Fake SDK client: records requests and returns canned parsed outputs keyed by schema shape. */
function fakeClient(respond: (params: Record<string, unknown>) => { stop_reason?: string; parsed_output: unknown }) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          calls.push(params);
          const r = respond(params);
          // Go through the real SDK output format, exactly as the SDK does with the model's JSON text.
          const format = (params.output_config as { format: { schema: object; parse: (s: string) => unknown } }).format;
          assert.ok(format.schema, "output format produced a JSON schema");
          const parsed = r.parsed_output == null ? null : format.parse(JSON.stringify(r.parsed_output));
          return { stop_reason: r.stop_reason ?? "end_turn", parsed_output: parsed, content: [] };
        },
      },
    },
  } as unknown as ClaudeClient;
  return { client, calls };
}

const ANALYSIS = {
  leadScore: 130, websiteScore: -5, quality: "LOW", summary: "Plumber with an old site.",
  painPoints: ["Not mobile friendly", "No booking"], recommendedOffer: "Mobile rebuild", recommendedChannel: "EMAIL",
  reasonForContacting: "Their site breaks on phones.",
};

/** Route by user prompt so one fake answers every function. */
function canned(params: Record<string, unknown>) {
  const user = String((params.messages as { content: string }[])[0].content);
  if (user.includes("Analyze this lead")) return { parsed_output: ANALYSIS };
  if (user.includes("first cold email")) return { parsed_output: { subject: " quick idea for Joe's ", body: " Hi Joe, ... Alex " } };
  if (user.includes("first text message")) return { parsed_output: { message: "Hi Joe, Alex from Keystone Web Agency here." } };
  if (user.includes("follow-up #")) {
    const isEmail = user.includes("as an email");
    return { parsed_output: isEmail ? { subject: "following up", body: "Hi again" } : { message: "Quick follow-up" } };
  }
  return { parsed_output: { classification: "NOT_INTERESTED", sentiment: "NEGATIVE", recommendedAction: "Mark lost", shouldPauseSequence: false } };
}

const lead = { businessName: "Joe's Plumbing", website: "joesplumbing.com", industry: "Plumber", city: "Austin", knownWebsiteIssues: ["No HTTPS"] };

test("analyzeLead sends a structured, server-side request and normalizes scores", async () => {
  const { client, calls } = fakeClient(canned);
  const svc = new ClaudeService({ client, agency, model: "claude-opus-5-5", effort: "medium" });
  const a = await svc.analyzeLead({ ...lead, description: "Family plumber", notes: "Referred by Sam" });
  assert.equal(a.leadScore, 100);
  assert.equal(a.websiteScore, 0);
  assert.equal(a.quality, "HIGH", "quality is derived from the clamped score");
  const req = calls[0];
  assert.equal(req.model, "claude-opus-5-5");
  assert.deepEqual(req.thinking, { type: "adaptive" });
  assert.equal(req.fallbacks, "default");
  assert.ok((req.output_config as { format: { type: string } }).format.type === "json_schema");
  const user = String((req.messages as { content: string }[])[0].content);
  assert.match(user, /Family plumber/);
  assert.match(user, /- No HTTPS/);
  assert.match(user, /Referred by Sam/);
  assert.match(String(req.system), /untrusted/i);
});

test("email, SMS and follow-ups return the documented shapes", async () => {
  const { client, calls } = fakeClient(canned);
  const svc = new ClaudeService({ client, agency });
  assert.deepEqual(await svc.generateColdEmail({ lead }), { subject: "quick idea for Joe's", body: "Hi Joe, ... Alex" });
  assert.deepEqual(await svc.generateColdSMS({ lead }), { message: "Hi Joe, Alex from Keystone Web Agency here." });
  assert.match(String(calls[0].system), /Keystone Web Agency/);
  assert.match(String(calls[0].system), /not spammy/);
  assert.match(String(calls[1].system), /casual, professional, human, short/);
  assert.deepEqual(await svc.generateFollowUp({ lead, channel: "EMAIL" }), { channel: "EMAIL", subject: "following up", body: "Hi again" });
  assert.deepEqual(await svc.generateFollowUp({ lead, channel: "SMS", followUpNumber: 3 }), { channel: "SMS", message: "Quick follow-up" });
  assert.match(String(calls[3].system), /final, polite check-in/);
});

test("classifyReply always pauses the sequence for real replies", async () => {
  const { client } = fakeClient(canned);
  const svc = new ClaudeService({ client, agency });
  const c = await svc.classifyReply({ replyText: "No thanks" });
  assert.deepEqual(c, { classification: "NOT_INTERESTED", sentiment: "NEGATIVE", recommendedAction: "Mark lost", shouldPauseSequence: true });
});

test("enum-like fields are normalized because the SDK doesn't enforce enums", async () => {
  const { client } = fakeClient((params) => {
    const user = String((params.messages as { content: string }[])[0].content);
    return user.includes("Analyze")
      ? { parsed_output: { ...ANALYSIS, leadScore: 55, recommendedChannel: "both" } }
      : { parsed_output: { classification: "meeting booked", sentiment: "excited", recommendedAction: " Confirm the time ", shouldPauseSequence: false } };
  });
  const svc = new ClaudeService({ client, agency });
  const a = await svc.analyzeLead(lead);
  assert.equal(a.quality, "MEDIUM");
  assert.equal(a.recommendedChannel, "BOTH");
  assert.deepEqual(await svc.classifyReply({ replyText: "Tuesday 3pm works" }), {
    classification: "MEETING_BOOKED", sentiment: "NEUTRAL", recommendedAction: "Confirm the time", shouldPauseSequence: true,
  });
});

test("malformed model output becomes a ClaudeOutputError", async () => {
  const { client } = fakeClient(() => ({ parsed_output: { leadScore: "high" } }));
  await assert.rejects(new ClaudeService({ client, agency }).analyzeLead(lead), ClaudeOutputError);
});

test("errors: not configured, refusal, invalid input", async () => {
  await assert.rejects(new ClaudeService({ agency }).analyzeLead(lead), ClaudeNotConfiguredError);
  const { client } = fakeClient(() => ({ stop_reason: "refusal", parsed_output: null }));
  await assert.rejects(new ClaudeService({ client, agency }).analyzeLead(lead), ClaudeOutputError);
  const ok = new ClaudeService({ client: fakeClient(canned).client, agency });
  await assert.rejects(ok.analyzeLead({ businessName: "" }), /businessName is required/);
  await assert.rejects(ok.analyzeLead({ businessName: "x", notes: "a".repeat(5000) }));
});

async function serve(claude: ClaudeService | null, cfgOver: { dashboardToken?: string; aiRateLimitPerMinute?: number } = {}) {
  const cfg = { ...testConfig(), ...cfgOver };
  const ctx = makePipeline(cfg, undefined, undefined, claude);
  const server = createApp(cfg, ctx.pipeline, claude).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { ...ctx, call, close: () => new Promise((r) => server.close(r)) };
}

test("lead endpoints save AI output for review and never send", async () => {
  const claude = new ClaudeService({ client: fakeClient(canned).client, agency });
  const s = await serve(claude);
  try {
    const { lead: l } = s.crm.upsertBusiness({ businessName: "Joe's Plumbing", website: "joesplumbing.com", phone: "5125550100", source: "test", sourceId: "1" });
    s.crm.updateLead(l.id, { email: "joe@joesplumbing.com" });

    const a = await s.call(`/api/ai/leads/${l.id}/analyze`, { description: "Family plumber since 1990", knownWebsiteIssues: ["Slow"] });
    assert.equal(a.status, 200);
    assert.equal(a.body.quality, "HIGH");
    const stored = s.crm.getLead(l.id)!;
    assert.equal(stored.analysis?.leadScore, 100);
    assert.equal(stored.score, 100);
    assert.equal(stored.description, "Family plumber since 1990");

    const e = await s.call(`/api/ai/leads/${l.id}/email`, {});
    assert.deepEqual(e.body, { subject: "quick idea for Joe's", body: "Hi Joe, ... Alex" });
    const sm = await s.call(`/api/ai/leads/${l.id}/sms`, {});
    assert.equal(sm.body.message, "Hi Joe, Alex from Keystone Web Agency here.");

    const d = s.crm.latestDraft(l.id)!;
    assert.equal(d.emailSubject, "quick idea for Joe's", "email carried into the SMS draft");
    assert.equal(d.smsBody, "Hi Joe, Alex from Keystone Web Agency here.");
    assert.equal(d.approved, false);
    assert.equal(s.crm.getLead(l.id)!.status, "drafted");

    // Even if someone had approved an earlier draft, new AI copy re-holds it.
    s.pipeline.approve(l.id);
    await s.call(`/api/ai/leads/${l.id}/email`, {});
    assert.equal(s.crm.getLead(l.id)!.status, "pending_approval");
    assert.equal((await s.pipeline.sendDue()).sent.length, 0);
    assert.equal(s.email.sent.length + s.sms.sent.length, 0, "nothing was sent");

    const fu = await s.call(`/api/ai/leads/${l.id}/follow-up`, { channel: "SMS" });
    assert.deepEqual(fu.body, { channel: "SMS", message: "Quick follow-up" });

    const c = await s.call(`/api/ai/leads/${l.id}/classify-reply`, { replyText: "Not for us, thanks" });
    assert.equal(c.body.classification, "NOT_INTERESTED");
    assert.equal(s.crm.getLead(l.id)!.status, "lost");

    assert.equal((await s.call(`/api/ai/leads/9999/email`, {})).status, 404);
  } finally {
    await s.close();
  }
});

test("stateless endpoints validate input", async () => {
  const s = await serve(new ClaudeService({ client: fakeClient(canned).client, agency }));
  try {
    const ok = await s.call("/api/ai/analyze-lead", { ...lead, description: "", notes: "" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.recommendedChannel, "EMAIL");
    const bad = await s.call("/api/ai/analyze-lead", { website: "x.com" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "invalid request");
    assert.equal((await s.call("/api/ai/generate-cold-sms", { lead })).body.message, "Hi Joe, Alex from Keystone Web Agency here.");
    assert.equal((await s.call("/api/ai/classify-reply", { replyText: "Sounds good" })).status, 200);
    assert.equal((await s.call("/api/ai/generate-follow-up", { lead, channel: "FAX" })).status, 400);
  } finally {
    await s.close();
  }
});

test("AI endpoints: 503 without a key, 401 without the token, 429 when over the limit", async () => {
  const none = await serve(null);
  try {
    assert.deepEqual((await none.call("/api/ai/status")).body, { configured: false, model: "claude-opus-5-5" });
    const r = await none.call("/api/ai/analyze-lead", lead);
    assert.equal(r.status, 503);
    assert.match(String(r.body.error), /ANTHROPIC_API_KEY/);
  } finally {
    await none.close();
  }

  const claude = new ClaudeService({ client: fakeClient(canned).client, agency });
  const locked = await serve(claude, { dashboardToken: "s3cret", aiRateLimitPerMinute: 2 });
  try {
    assert.equal((await locked.call("/api/ai/analyze-lead", lead)).status, 401);
    const auth = { Authorization: "Bearer s3cret" };
    assert.equal((await locked.call("/api/ai/analyze-lead", lead, auth)).status, 200);
    assert.equal((await locked.call("/api/ai/analyze-lead", lead, auth)).status, 200);
    assert.equal((await locked.call("/api/ai/analyze-lead", lead, auth)).status, 429);
  } finally {
    await locked.close();
  }
});
