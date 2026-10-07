import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fakeFetch, makePipeline, OLD_SITE, testConfig } from "./helpers.js";
import { verifyResendWebhook } from "../src/channels/email.js";
import { validateTwilioWebhook } from "../src/services/sms/twilio.js";
import { applyDeliveryUpdate } from "../src/services/delivery.js";

const places = {
  places: [
    {
      id: "p1", displayName: { text: "Joe's Plumbing" }, nationalPhoneNumber: "(512) 555-0100", websiteUri: "http://joesplumbing.com",
      primaryTypeDisplayName: { text: "Plumber" }, addressComponents: [{ longText: "Austin", types: ["locality"] }], rating: 4.6, userRatingCount: 88,
    },
    { id: "p2", displayName: { text: "No Site Roofing" }, nationalPhoneNumber: "(512) 555-0199", primaryTypeDisplayName: { text: "Roofer" } },
  ],
};

function setup(now = new Date("2026-10-07T15:00:00Z")) {
  let clock = now;
  const f = fakeFetch({
    "https://places.googleapis.com": { body: places },
    "http://joesplumbing.com/contact-us": { body: "<p>Reach the office: office@joesplumbing.com</p>" },
    "http://joesplumbing.com": { body: OLD_SITE },
  });
  const ctx = makePipeline(testConfig(), f, () => clock);
  return { ...ctx, f, advance: (days: number) => (clock = new Date(clock.getTime() + days * 86_400_000)) };
}

test("end to end: find → enrich → draft → auto-approve → send → delivered → replied → interested → booked → closed", async () => {
  const { pipeline, crm, email, sms, advance } = setup();

  const found = await pipeline.findLeads({ industry: "plumber", city: "Austin, TX" });
  assert.equal(found.created.length, 2);
  const again = await pipeline.findLeads({ industry: "plumber", city: "Austin, TX" });
  assert.equal(again.created.length, 0, "dedupes on rerun");

  const joeId = found.created[0].id;
  const joe = await pipeline.enrich(joeId);
  assert.equal(joe.email, "joe@joesplumbing.com");
  assert.equal(joe.contactName, "Joe Smith");
  assert.equal(joe.status, "enriched");
  assert.ok(joe.audit!.findings.some((f) => f.code === "not_mobile_friendly"));
  assert.ok((joe.score ?? 0) >= 50, `score ${joe.score}`);

  const { decision } = await pipeline.draft(joeId);
  assert.equal(decision.action, "auto_approve");
  assert.equal(crm.getLead(joeId)!.status, "approved");

  // grant SMS consent (e.g. they filled a form) so the text can go out later
  crm.setContactPreferences(joeId, { smsConsent: true }, "test");

  const r1 = await pipeline.sendDue();
  assert.deepEqual(r1.sent, [{ leadId: joeId, channel: "email" }]);
  assert.ok(r1.held.some((h) => h.channel === "sms" && /scheduled/.test(h.reason)));
  assert.equal(email.sent.length, 1);
  assert.match(email.sent[0].text, /Unsubscribe: https:\/\/crm\.example\.test\/unsubscribe\//);
  assert.equal(crm.getLead(joeId)!.status, "sent");
  assert.equal(crm.getLead(joeId)!.emailStatus, "SENT");

  const emailMsg = crm.communicationsForLead(joeId)[0];
  assert.equal(emailMsg.direction, "OUTBOUND");
  assert.equal(emailMsg.channel, "EMAIL");
  assert.ok(applyDeliveryUpdate(crm, { provider: emailMsg.provider, providerMessageId: emailMsg.providerMessageId!, update: "DELIVERED" }));
  assert.equal(crm.getLead(joeId)!.status, "delivered");
  assert.equal(crm.getLead(joeId)!.emailStatus, "DELIVERED");

  advance(3);
  const r2 = await pipeline.sendDue();
  assert.deepEqual(r2.sent, [{ leadId: joeId, channel: "sms" }]);
  assert.match(sms.sent[0].body, /Reply STOP to opt out\.$/);
  const r3 = await pipeline.sendDue();
  assert.equal(r3.sent.length, 0, "never double-sends");

  const reply = pipeline.handleInboundEmail("Joe Smith <JOE@joesplumbing.com>", "Sure, tell me more", "RESEND");
  assert.equal((await reply.classification)?.classification, "INTERESTED");
  const after = crm.getLead(joeId)!;
  assert.equal(after.status, "interested");
  assert.equal(after.replied, true);
  assert.equal(after.sequencePaused, true);

  // late delivery webhook must not regress the stage
  const smsMsg = crm.communicationsForLead(joeId).find((m) => m.channel === "SMS" && m.direction === "OUTBOUND")!;
  applyDeliveryUpdate(crm, { provider: smsMsg.provider, providerMessageId: smsMsg.providerMessageId!, update: "DELIVERED" });
  assert.equal(crm.getLead(joeId)!.status, "interested");

  pipeline.markStage(joeId, "booked");
  pipeline.markStage(joeId, "closed");
  assert.equal(crm.getLead(joeId)!.status, "closed");

  const { funnel } = crm.stats();
  assert.deepEqual(funnel, { sent: 1, delivered: 1, replied: 1, interested: 1, booked: 1, closed: 1 });
});

test("lead with no website or email is queued for review, not auto-sent", async () => {
  const { pipeline, crm, email } = setup();
  const { created } = await pipeline.findLeads({ industry: "roofer", city: "Austin" });
  const roof = created[1];
  const e = await pipeline.enrich(roof.id);
  assert.ok(e.audit!.findings.some((f) => f.code === "no_website"));
  const { decision } = await pipeline.draft(roof.id);
  assert.equal(decision.action, "needs_approval");
  assert.equal(crm.getLead(roof.id)!.status, "pending_approval");
  assert.equal((await pipeline.sendDue()).sent.length, 0);

  pipeline.approve(roof.id, { smsBody: "Edited by a human" });
  assert.equal(crm.latestDraft(roof.id)!.smsBody, "Edited by a human");
  // SMS-only lead without consent: still blocked by TCPA rule
  assert.match((await pipeline.trySend(roof.id, "sms"))!, /consent/);
  assert.equal(email.sent.length, 0);
});

test("STOP text opts the lead out of SMS (only) and blocks future texts", async () => {
  const { pipeline, crm } = setup();
  const { created } = await pipeline.findLeads({ industry: "plumber", city: "Austin" });
  const id = created[0].id;
  await pipeline.enrich(id);
  await pipeline.draft(id);
  await pipeline.sendDue();
  const r = pipeline.handleIncomingSms({ From: "+1 (512) 555-0100", To: "+15125550000", Body: "STOP", MessageSid: "SMstop1" });
  assert.equal(r.kind, "opt_out");
  assert.equal((await r.classification)?.classification, "UNSUBSCRIBE");
  const lead = crm.getLead(id)!;
  assert.equal(lead.smsOptOut, true);
  assert.equal(lead.emailOptOut, false, "STOP is SMS-only");
  assert.notEqual(lead.status, "opted_out", "email is still a valid channel");
  assert.ok(crm.isSuppressed("5125550100"));
  assert.ok(!crm.isSuppressed("joe@joesplumbing.com"));
  assert.match((await pipeline.trySend(id, "sms"))!, /opted out|already|replied|paused/);
});

test("unsubscribe link token is verified", async () => {
  const { pipeline, crm } = setup();
  const { created } = await pipeline.findLeads({ industry: "plumber", city: "Austin" });
  const id = created[0].id;
  assert.equal(pipeline.unsubscribe(id, "wrong-token-wrong-token-wrong-to"), false);
  const token = pipeline.unsubscribeUrl(id).split("/").pop()!;
  assert.equal(pipeline.unsubscribe(id, token), true);
  assert.equal(crm.getLead(id)!.emailOptOut, true);
});

test("bounce suppresses the address", async () => {
  const { pipeline, crm } = setup();
  const { created } = await pipeline.findLeads({ industry: "plumber", city: "Austin" });
  const id = created[0].id;
  await pipeline.enrich(id);
  await pipeline.draft(id);
  await pipeline.sendDue();
  const m = crm.communicationsForLead(id)[0];
  applyDeliveryUpdate(crm, { provider: m.provider, providerMessageId: m.providerMessageId!, update: "BOUNCED", error: "mailbox does not exist" });
  assert.equal(crm.getLead(id)!.status, "bounced");
  assert.equal(crm.getLead(id)!.emailStatus, "BOUNCED");
  assert.ok(crm.isSuppressed("joe@joesplumbing.com"));
});

test("Resend (Svix) webhook signature", () => {
  const secret = "whsec_" + Buffer.from("supersecretkey").toString("base64");
  const body = '{"type":"email.delivered","data":{"email_id":"abc"}}';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", Buffer.from("supersecretkey")).update(`msg_1.${ts}.${body}`).digest("base64");
  assert.equal(verifyResendWebhook(secret, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, body), true);
  assert.equal(verifyResendWebhook(secret, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, body + " "), false);
  assert.equal(verifyResendWebhook(secret, { id: "msg_1", timestamp: "1000", signature: `v1,${sig}` }, body), false);
});

test("Twilio webhook signature (official SDK validator)", () => {
  const url = "https://crm.example.test/api/webhooks/twilio/incoming";
  const params = { From: "+15125550100", Body: "Yes", MessageSid: "SM1" };
  const data = url + "BodyYes" + "From+15125550100" + "MessageSidSM1";
  const sig = createHmac("sha1", "tok").update(data).digest("base64");
  assert.equal(validateTwilioWebhook("tok", sig, url, params), true);
  assert.equal(validateTwilioWebhook("tok", sig, url, { ...params, Body: "No" }), false);
  assert.equal(validateTwilioWebhook("tok", undefined, url, params), false);
  assert.equal(validateTwilioWebhook("", sig, url, params), false);
});
