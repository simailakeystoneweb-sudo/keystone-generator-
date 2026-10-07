import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import twilio from "twilio";
import { CRM } from "../src/crm/db.js";
import { Pipeline } from "../src/pipeline.js";
import { createApp } from "../src/web/server.js";
import { ResendEmailSender, sendLeadEmail, type ResendLike } from "../src/services/email/resend.js";
import { TwilioSmsSender, sendLeadSMS, handleIncomingSms, type TwilioLike } from "../src/services/sms/twilio.js";
import { toE164 } from "../src/services/sms/phone.js";
import { ProviderSendError, SendRejectedError } from "../src/services/errors.js";
import { smsKeyword, isOptOutPhrase } from "../src/services/replies.js";
import { FakePersonalizer, testConfig } from "./helpers.js";
import type { Config } from "../src/config.js";

const NOW = new Date("2026-10-07T15:00:00Z"); // 15:00 UTC, TIMEZONE=UTC in tests → outside quiet hours

function fakeResend(reply: (payload: Record<string, unknown>) => unknown = () => ({ data: { id: `re_${Math.random().toString(36).slice(2)}` }, error: null })) {
  const calls: { payload: Record<string, unknown>; opts: unknown }[] = [];
  const client = {
    emails: {
      send: async (payload: Record<string, unknown>, opts?: unknown) => {
        calls.push({ payload, opts });
        return { headers: null, ...(reply(payload) as object) };
      },
    },
  } as unknown as ResendLike;
  return { client, calls };
}

function fakeTwilio(reply: () => Promise<{ sid: string }> = async () => ({ sid: `SM${Math.random().toString(36).slice(2, 12)}` })) {
  const calls: Record<string, unknown>[] = [];
  const client: TwilioLike = { messages: { create: async (o) => (calls.push(o), reply()) } };
  return { client, calls };
}

function world(opts: { resend?: ReturnType<typeof fakeResend>; twilio?: ReturnType<typeof fakeTwilio>; now?: Date; cfg?: Config } = {}) {
  const cfg = opts.cfg ?? testConfig();
  const crm = new CRM(":memory:");
  const resend = opts.resend ?? fakeResend();
  const tw = opts.twilio ?? fakeTwilio();
  let clock = opts.now ?? NOW;
  const email = new ResendEmailSender({ client: resend.client, replyTo: "alex@keystone.test" });
  const sms = new TwilioSmsSender({ client: tw.client, phoneNumber: cfg.twilioPhoneNumber });
  const personalizer = new FakePersonalizer();
  const pipeline = new Pipeline({ cfg, crm, personalizer, email, sms, now: () => clock });
  let n = 0;
  // First lead in a world gets (512) 555-0100; later ones get unique numbers so the CRM's
  // phone de-duplication doesn't hand back an earlier lead.
  const addLead = (over: { email?: string | null; phone?: string | null; status?: string } = {}) => {
    const phone = over.phone !== undefined ? over.phone : n === 0 ? "(512) 555-0100" : `(512) 555-07${String(n).padStart(2, "0")}`;
    n++;
    const { lead, created } = crm.upsertBusiness({ businessName: "Joe's Plumbing", phone, source: "test", sourceId: String(Math.random()) });
    assert.ok(created || over.phone === null, `addLead reused lead ${lead.id} (phone ${phone})`);
    crm.updateLead(lead.id, { email: over.email === undefined ? "joe@joesplumbing.com" : over.email, contactName: "Joe Smith" });
    if (over.status) crm.setStatus(lead.id, over.status as never, "test", { force: true });
    return crm.getLead(lead.id)!;
  };
  const deps = { crm, cfg, sender: email, now: () => clock };
  const smsDeps = { crm, cfg, sender: sms, now: () => clock };
  return { cfg, crm, resend, tw, email, sms, personalizer, pipeline, addLead, deps, smsDeps, setClock: (d: Date) => (clock = d) };
}

const rejectsWith = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof SendRejectedError, `expected SendRejectedError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
};

// ---------------------------------------------------------------- email

test("sendLeadEmail: sends via Resend, records the communication, updates the lead", async () => {
  const w = world();
  const lead = w.addLead();
  assert.equal(lead.status, "new");
  const r = await sendLeadEmail({ leadId: lead.id, email: "Joe@JoesPlumbing.com", subject: "Quick idea for Joe's", body: "Hi Joe,\n\nYour site breaks on phones.\n\nAlex", campaignId: "fall-2026" }, w.deps, { idempotencyKey: "key-12345678" });

  // Resend request
  assert.equal(w.resend.calls.length, 1);
  const { payload, opts } = w.resend.calls[0];
  assert.equal(payload.from, '"Keystone Web Agency" <hello@keystone.test>');
  assert.deepEqual(payload.to, ["joe@joesplumbing.com"]);
  assert.equal(payload.subject, "Quick idea for Joe's");
  assert.equal(payload.replyTo, "alex@keystone.test");
  assert.match(String(payload.text), /Your site breaks on phones[\s\S]*Unsubscribe: https:\/\/crm\.example\.test\/unsubscribe\//);
  assert.match(String((payload.headers as Record<string, string>)["List-Unsubscribe"]), /^<https:\/\/crm\.example\.test\/unsubscribe\//);
  assert.deepEqual(payload.tags, [{ name: "lead_id", value: String(lead.id) }, { name: "campaign_id", value: "fall-2026" }]);
  assert.deepEqual(opts, { idempotencyKey: "key-12345678" });

  // Communication record
  const c = r.communication;
  assert.equal(c.direction, "OUTBOUND");
  assert.equal(c.channel, "EMAIL");
  assert.equal(c.provider, "RESEND");
  assert.match(c.providerMessageId!, /^re_/);
  assert.equal(c.subject, "Quick idea for Joe's");
  assert.match(c.body, /Your site breaks on phones/);
  assert.equal(c.sentAt, NOW.toISOString());
  assert.equal(c.campaignId, "fall-2026");
  assert.deepEqual(w.crm.communicationsForLead(lead.id).map((x) => x.id), [c.id]);

  // Lead update
  const after = w.crm.getLead(lead.id)!;
  assert.equal(after.emailStatus, "SENT");
  assert.equal(after.lastContactedAt, NOW.toISOString());
  assert.equal(after.status, "sent", "NEW → contacted");
  assert.equal(r.dryRun, false);
});

test("sendLeadEmail: status only moves to contacted from pre-contact stages", async () => {
  const w = world();
  const qualified = w.addLead({ status: "enriched" });
  await sendLeadEmail({ leadId: qualified.id, email: qualified.email!, subject: "s", body: "b" }, w.deps);
  assert.equal(w.crm.getLead(qualified.id)!.status, "sent");

  const interested = w.addLead({ status: "interested" });
  await sendLeadEmail({ leadId: interested.id, email: interested.email!, subject: "s", body: "b" }, w.deps);
  const i = w.crm.getLead(interested.id)!;
  assert.equal(i.status, "interested", "later stages are left alone");
  assert.equal(i.emailStatus, "SENT");
  assert.equal(i.lastContactedAt, NOW.toISOString());
});

test("sendLeadEmail: rejects leads that can't be contacted, and sends nothing", async () => {
  const w = world();
  const base = { subject: "Hello", body: "Body" };
  await rejectsWith(sendLeadEmail({ leadId: 999, email: "x@y.com", ...base }, w.deps), "LEAD_NOT_FOUND");

  const noEmail = w.addLead({ email: null });
  await rejectsWith(sendLeadEmail({ leadId: noEmail.id, email: "x@y.com", ...base }, w.deps), "NO_EMAIL");

  const optedOut = w.addLead();
  w.crm.optOut(optedOut.id, { email: true }, "test");
  await rejectsWith(sendLeadEmail({ leadId: optedOut.id, email: optedOut.email!, ...base }, w.deps), "EMAIL_OPT_OUT");

  const dnc = w.addLead({ email: "dnc@example.com" });
  w.crm.setContactPreferences(dnc.id, { doNotContact: true }, "test");
  await rejectsWith(sendLeadEmail({ leadId: dnc.id, email: dnc.email!, ...base }, w.deps), "DO_NOT_CONTACT");

  const bounced = w.addLead({ email: "bounced@example.com" });
  w.crm.suppress("bounced@example.com", "hard bounce");
  await rejectsWith(sendLeadEmail({ leadId: bounced.id, email: bounced.email!, ...base }, w.deps), "SUPPRESSED");

  const ok = w.addLead({ email: "real@example.com" });
  await rejectsWith(sendLeadEmail({ leadId: ok.id, email: "attacker@evil.com", ...base }, w.deps), "EMAIL_MISMATCH");
  await rejectsWith(sendLeadEmail({ leadId: ok.id, email: ok.email!, subject: "a\r\nBcc: x@y.com", body: "b" }, w.deps), "INVALID_INPUT");
  await rejectsWith(sendLeadEmail({ leadId: ok.id, email: ok.email!, subject: "s", body: "   " }, w.deps), "INVALID_INPUT");
  await rejectsWith(sendLeadEmail({ leadId: ok.id, email: ok.email!, ...base }, { ...w.deps, sender: null }), "NOT_CONFIGURED");

  assert.equal(w.resend.calls.length, 0, "nothing reached Resend");
  assert.equal(w.crm.getLead(ok.id)!.emailStatus, null);
});

test("sendLeadEmail: Resend errors are recorded as FAILED and the lead is unchanged", async () => {
  const resend = fakeResend(() => ({ data: null, error: { message: "The keystone.test domain is not verified", name: "validation_error", statusCode: 403 } }));
  const w = world({ resend });
  const lead = w.addLead();
  await assert.rejects(sendLeadEmail({ leadId: lead.id, email: lead.email!, subject: "s", body: "b" }, w.deps), (err: unknown) => {
    assert.ok(err instanceof ProviderSendError);
    assert.match(err.message, /domain is not verified/);
    assert.equal(err.providerCode, "validation_error");
    return true;
  });
  const [c] = w.crm.communicationsForLead(lead.id);
  assert.equal(c.status, "FAILED");
  assert.equal(c.sentAt, null);
  const after = w.crm.getLead(lead.id)!;
  assert.equal(after.status, "new");
  assert.equal(after.emailStatus, null);
  assert.equal(after.lastContactedAt, null);
});

test("sendLeadEmail: idempotency key and per-lead lock prevent double sends", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const resend = fakeResend();
  const slow = { emails: { send: async (p: never, o: never) => (await gate, resend.client.emails.send(p, o)) } } as unknown as ResendLike;
  const w = world({ resend: { client: slow, calls: resend.calls } });
  const lead = w.addLead();
  const input = { leadId: lead.id, email: lead.email!, subject: "s", body: "b" };
  const first = sendLeadEmail(input, w.deps, { idempotencyKey: "same-key-1" });
  await rejectsWith(sendLeadEmail(input, w.deps, { idempotencyKey: "other-key-2" }), "SEND_IN_PROGRESS");
  release();
  await first;
  const again = await sendLeadEmail(input, w.deps, { idempotencyKey: "same-key-1" });
  assert.equal(again.duplicate, true);
  assert.equal(resend.calls.length, 1, "Resend called once");
  assert.equal(w.crm.communicationsForLead(lead.id).length, 1);
});

// ---------------------------------------------------------------- sms

test("toE164 / keyword helpers", () => {
  assert.equal(toE164("(512) 555-0100"), "+15125550100");
  assert.equal(toE164("1-512-555-0100"), "+15125550100");
  assert.equal(toE164("+44 20 7946 0958"), "+442079460958");
  assert.equal(toE164("0044 20 7946 0958"), "+442079460958");
  for (const bad of ["555-0100", "1-800-FLOWERS", "512 555 0100 x12", "(012) 555-0100", "(911) 555-0100", "(512) 055-0100", "+1 512 555 010", "", null]) {
    assert.equal(toE164(bad as string | null), null, String(bad));
  }
  for (const k of ["STOP", "stop", " Stop. ", "STOPALL", "stop all", "UNSUBSCRIBE", "Cancel", "END", "quit", "Opt out", "REVOKE"]) assert.equal(smsKeyword(k), "OPT_OUT", k);
  for (const k of ["End of day works for me", "Cancel my 3pm, can we do 4?", "Please don't stop", "stopping by later"]) assert.notEqual(smsKeyword(k), "OPT_OUT", k);
  assert.equal(isOptOutPhrase("Please remove me from your list"), true);
  assert.equal(isOptOutPhrase("stop texting me"), true);
  assert.equal(isOptOutPhrase("End of day works for me"), false);
  assert.equal(smsKeyword("START"), "OPT_IN");
  assert.equal(smsKeyword("help"), "HELP");
});

test("sendLeadSMS: sends via Twilio, records the communication, updates the lead", async () => {
  const w = world();
  const lead = w.addLead();
  w.crm.setContactPreferences(lead.id, { smsConsent: true }, "test");
  const r = await sendLeadSMS({ leadId: lead.id, phone: "512.555.0100", message: "Hi Joe, Alex from Keystone Web Agency here. Want a free mockup?" }, w.smsDeps);

  assert.equal(w.tw.calls.length, 1);
  assert.deepEqual(w.tw.calls[0], {
    to: "+15125550100",
    from: "+15125550000",
    body: "Hi Joe, Alex from Keystone Web Agency here. Want a free mockup? Reply STOP to opt out.",
    statusCallback: "https://crm.example.test/api/webhooks/twilio/status",
  });
  const c = r.communication;
  assert.equal(c.direction, "OUTBOUND");
  assert.equal(c.channel, "SMS");
  assert.equal(c.provider, "TWILIO");
  assert.match(c.providerMessageId!, /^SM/);
  assert.match(c.body, /Reply STOP to opt out\.$/);
  assert.equal(c.sentAt, NOW.toISOString());
  const after = w.crm.getLead(lead.id)!;
  assert.equal(after.smsStatus, "SENT");
  assert.equal(after.lastContactedAt, NOW.toISOString());
  assert.equal(after.status, "sent");
});

test("sendLeadSMS: rejects invalid numbers, opt-outs, do-not-contact, missing consent and quiet hours", async () => {
  const w = world();
  const msg = { message: "Hi" };
  await rejectsWith(sendLeadSMS({ leadId: 999, phone: "+15125550100", ...msg }, w.smsDeps), "LEAD_NOT_FOUND");

  const consented = (over?: Parameters<typeof w.addLead>[0]) => {
    const l = w.addLead(over);
    w.crm.setContactPreferences(l.id, { smsConsent: true }, "test");
    return w.crm.getLead(l.id)!;
  };
  const a = consented();
  await rejectsWith(sendLeadSMS({ leadId: a.id, phone: "1-800-FLOWERS", ...msg }, w.smsDeps), "INVALID_PHONE");
  await rejectsWith(sendLeadSMS({ leadId: a.id, phone: "+15125559999", ...msg }, w.smsDeps), "PHONE_MISMATCH");

  const noPhone = consented({ phone: null, email: "np@example.com" });
  await rejectsWith(sendLeadSMS({ leadId: noPhone.id, phone: "+15125550100", ...msg }, w.smsDeps), "INVALID_PHONE");

  const out = consented({ phone: "(512) 555-0111", email: "o@example.com" });
  w.crm.optOut(out.id, { sms: true }, "test");
  await rejectsWith(sendLeadSMS({ leadId: out.id, phone: "(512) 555-0111", ...msg }, w.smsDeps), "SMS_OPT_OUT");

  const dnc = consented({ phone: "(512) 555-0122", email: "d@example.com" });
  w.crm.setContactPreferences(dnc.id, { doNotContact: true }, "test");
  await rejectsWith(sendLeadSMS({ leadId: dnc.id, phone: "(512) 555-0122", ...msg }, w.smsDeps), "DO_NOT_CONTACT");

  const noConsent = w.addLead({ phone: "(512) 555-0133", email: "nc@example.com" });
  await rejectsWith(sendLeadSMS({ leadId: noConsent.id, phone: "(512) 555-0133", ...msg }, w.smsDeps), "NO_SMS_CONSENT");

  const late = consented({ phone: "(512) 555-0144", email: "l@example.com" });
  w.setClock(new Date("2026-10-07T22:30:00Z"));
  await rejectsWith(sendLeadSMS({ leadId: late.id, phone: "(512) 555-0144", ...msg }, w.smsDeps), "QUIET_HOURS");
  w.setClock(NOW);

  assert.equal(w.tw.calls.length, 0, "nothing reached Twilio");
});

test("sendLeadSMS: Twilio 21610 (recipient unsubscribed) is mirrored as a permanent opt-out", async () => {
  const tw = fakeTwilio(async () => {
    throw Object.assign(new Error("Attempt to send to unsubscribed recipient"), { code: 21610, status: 400 });
  });
  const w = world({ twilio: tw });
  const lead = w.addLead();
  w.crm.setContactPreferences(lead.id, { smsConsent: true }, "test");
  await rejectsWith(sendLeadSMS({ leadId: lead.id, phone: lead.phone!, message: "Hi" }, w.smsDeps), "SMS_OPT_OUT");
  const after = w.crm.getLead(lead.id)!;
  assert.equal(after.smsOptOut, true);
  assert.equal(after.smsConsent, false);
  assert.equal(w.crm.communicationsForLead(lead.id)[0].status, "FAILED");
});

// ---------------------------------------------------------------- incoming SMS

test("incoming SMS: records INBOUND, marks replied, pauses the sequence, stores Claude's classification", async () => {
  const w = world();
  const lead = w.addLead({ status: "sent" });
  w.personalizer.nextClass = "INTERESTED";
  const r = handleIncomingSms({ From: "+15125550100", To: "+15125550000", Body: "Sounds good, call me tomorrow", MessageSid: "SMin1" }, { crm: w.crm, classify: w.pipeline.classifier, now: () => NOW });
  assert.equal(r.kind, "reply");
  const mid = w.crm.getLead(lead.id)!;
  assert.equal(mid.replied, true, "marked replied before classification finishes");
  assert.equal(mid.sequencePaused, true);
  const cls = await r.classification;
  assert.equal(cls?.classification, "INTERESTED");
  assert.equal(cls?.source, "claude");
  const [c] = w.crm.communicationsForLead(lead.id);
  assert.equal(c.direction, "INBOUND");
  assert.equal(c.channel, "SMS");
  assert.equal(c.provider, "TWILIO");
  assert.equal(c.providerMessageId, "SMin1");
  assert.equal(c.sender, "+15125550100");
  assert.equal(c.recipient, "+15125550000");
  assert.equal(c.body, "Sounds good, call me tomorrow");
  assert.equal(c.classification?.classification, "INTERESTED");
  const after = w.crm.getLead(lead.id)!;
  assert.equal(after.status, "interested");
  assert.equal(after.lastReplyClassification?.classification, "INTERESTED");

  // Twilio retry of the same MessageSid is ignored
  assert.equal(handleIncomingSms({ From: "+15125550100", Body: "Sounds good", MessageSid: "SMin1" }, { crm: w.crm, classify: null }).kind, "duplicate");
  assert.equal(w.crm.communicationsForLead(lead.id).length, 1);
});

test("incoming SMS: STOP keywords opt out permanently; START doesn't undo it; only a manual change does", async () => {
  const w = world();
  for (const [i, kw] of ["STOP", "stopall", "Unsubscribe", "CANCEL", "end", "Quit."].entries()) {
    const l = w.addLead({ phone: `(512) 555-02${10 + i}`, email: `l${i}@example.com` });
    const r = handleIncomingSms({ From: l.phone!, Body: kw, MessageSid: `SMkw${i}` }, { crm: w.crm, classify: w.pipeline.classifier });
    assert.equal(r.kind, "opt_out", kw);
    assert.equal(w.crm.getLead(l.id)!.smsOptOut, true, kw);
  }
  assert.equal(w.personalizer.drafts, 0);

  const lead = w.addLead();
  const phone = lead.phone!;
  w.crm.setContactPreferences(lead.id, { smsConsent: true }, "test");
  handleIncomingSms({ From: phone, Body: "STOP", MessageSid: "SMs1" }, { crm: w.crm, classify: null });
  const opted = w.crm.getLead(lead.id)!;
  assert.equal(opted.smsOptOut, true);
  assert.equal(opted.smsConsent, false, "consent revoked");
  assert.equal(opted.lastReplyClassification?.classification, "UNSUBSCRIBE");

  // Texting START: Twilio re-enables delivery, but our opt-out stays until changed manually.
  const start = handleIncomingSms({ From: phone, Body: "START", MessageSid: "SMs2" }, { crm: w.crm, classify: null });
  assert.equal(start.kind, "opt_in_request");
  assert.equal(w.crm.getLead(lead.id)!.smsOptOut, true);
  // Re-importing / enriching the lead doesn't reset it either.
  w.crm.upsertBusiness({ businessName: "Joe's Plumbing", phone, source: "csv" });
  w.crm.updateLead(lead.id, { phone, email: "joe@joesplumbing.com" });
  assert.equal(w.crm.getLead(lead.id)!.smsOptOut, true);
  await rejectsWith(sendLeadSMS({ leadId: lead.id, phone, message: "Hi" }, w.smsDeps), "SMS_OPT_OUT");
  assert.throws(() => w.crm.setContactPreferences(lead.id, { smsConsent: true }, "test"), /cannot record SMS consent/);

  // Manual re-enable (dashboard) clears the flag and the suppression; consent must be re-recorded.
  w.crm.setContactPreferences(lead.id, { smsOptOut: false }, "dashboard");
  await rejectsWith(sendLeadSMS({ leadId: lead.id, phone, message: "Hi" }, w.smsDeps), "NO_SMS_CONSENT");
  w.crm.setContactPreferences(lead.id, { smsConsent: true }, "dashboard");
  await sendLeadSMS({ leadId: lead.id, phone, message: "Hi" }, w.smsDeps);
  assert.ok(w.crm.eventsForLead(lead.id).some((e) => e.type === "contact.manual_change" && /sms_opt_out true → false/.test(e.detail ?? "")));
});

test("incoming SMS: STOP from an unknown number suppresses it for any future lead", async () => {
  const w = world();
  assert.equal(handleIncomingSms({ From: "+15125550199", Body: "STOP", MessageSid: "SMu1" }, { crm: w.crm, classify: null }).kind, "unknown_sender");
  const later = w.addLead({ phone: "(512) 555-0199", email: "later@example.com" });
  w.crm.setContactPreferences(later.id, { smsConsent: true }, "test");
  await rejectsWith(sendLeadSMS({ leadId: later.id, phone: "(512) 555-0199", message: "Hi" }, w.smsDeps), "SUPPRESSED");
});

test("incoming SMS: free-text 'stop contacting me' and Claude UNSUBSCRIBE opt out of everything; failures leave it for a human", async () => {
  const w = world();
  const a = w.addLead();
  await handleIncomingSms({ From: a.phone!, Body: "Please stop texting me", MessageSid: "SMf1" }, { crm: w.crm, classify: w.pipeline.classifier }).classification;
  const aa = w.crm.getLead(a.id)!;
  assert.equal(aa.smsOptOut && aa.emailOptOut, true);

  const b = w.addLead({ phone: "(512) 555-0301", email: "b@example.com" });
  w.personalizer.nextClass = "UNSUBSCRIBE";
  await handleIncomingSms({ From: b.phone!, Body: "Not something we want, thanks, don't reach out", MessageSid: "SMf2" }, { crm: w.crm, classify: w.pipeline.classifier }).classification;
  const bb = w.crm.getLead(b.id)!;
  assert.equal(bb.smsOptOut && bb.emailOptOut, true);
  assert.equal(bb.status, "opted_out");

  const c = w.addLead({ phone: "(512) 555-0302", email: "c@example.com", status: "sent" });
  const failing = async () => { throw new Error("overloaded"); };
  const res = await handleIncomingSms({ From: c.phone!, Body: "Who is this?", MessageSid: "SMf3" }, { crm: w.crm, classify: failing }).classification;
  assert.equal(res, null);
  const cc = w.crm.getLead(c.id)!;
  assert.equal(cc.replied, true);
  assert.equal(cc.status, "replied");
  assert.ok(w.crm.eventsForLead(c.id).some((e) => e.type === "reply.unclassified"));
});

// ---------------------------------------------------------------- HTTP: webhooks + send routes

async function serve(w: ReturnType<typeof world>) {
  const server = createApp(w.cfg, w.pipeline, null).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text); } catch { /* xml / text */ }
    return { status: res.status, text, body: json };
  };
  const twilioPost = (p: string, params: Record<string, string>, opts: { token?: string } = {}) => {
    const sig = twilio.getExpectedTwilioSignature(opts.token ?? w.cfg.twilioAuthToken, `${w.cfg.publicBaseUrl}${p}`, params);
    return call("POST", p, new URLSearchParams(params).toString(), { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig });
  };
  return { call, twilioPost, close: () => new Promise((r) => server.close(r)) };
}

const waitFor = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("POST /api/webhooks/twilio/incoming: signed requests only; replies and STOP update the lead", async () => {
  const w = world();
  const lead = w.addLead({ status: "sent" });
  const s = await serve(w);
  try {
    const params = { From: "+15125550100", To: "+15125550000", Body: "Yes, interested!", MessageSid: "SMh1" };
    const forged = await s.call("POST", "/api/webhooks/twilio/incoming", new URLSearchParams(params).toString(), { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "bogus" });
    assert.equal(forged.status, 403);
    assert.equal(w.crm.communicationsForLead(lead.id).length, 0);
    assert.equal((await s.twilioPost("/api/webhooks/twilio/incoming", params, { token: "wrong" })).status, 403);

    const ok = await s.twilioPost("/api/webhooks/twilio/incoming", params);
    assert.equal(ok.status, 200);
    assert.match(ok.text, /<Response><\/Response>/, "empty TwiML: we never auto-reply");
    assert.equal(w.crm.getLead(lead.id)!.replied, true);
    await waitFor(() => w.crm.getLead(lead.id)!.lastReplyClassification !== null);
    assert.equal(w.crm.getLead(lead.id)!.status, "interested");

    const stop = await s.twilioPost("/api/webhooks/twilio/incoming", { From: "+15125550100", To: "+15125550000", Body: "STOP", MessageSid: "SMh2" });
    assert.equal(stop.status, 200);
    assert.equal(w.crm.getLead(lead.id)!.smsOptOut, true);

    // Legacy URL still works (and is still signature-checked).
    assert.equal((await s.call("POST", "/webhooks/twilio/inbound", "From=%2B15125550100&Body=hi", { "Content-Type": "application/x-www-form-urlencoded" })).status, 403);
  } finally {
    await s.close();
  }
});

test("POST /api/webhooks/twilio/status updates sms_status; 21610 marks SMS opt-out", async () => {
  const w = world();
  const lead = w.addLead();
  w.crm.setContactPreferences(lead.id, { smsConsent: true }, "test");
  const { communication } = await sendLeadSMS({ leadId: lead.id, phone: lead.phone!, message: "Hi" }, w.smsDeps);
  const s = await serve(w);
  try {
    const sid = communication.providerMessageId!;
    assert.equal((await s.twilioPost("/api/webhooks/twilio/status", { MessageSid: sid, MessageStatus: "delivered" })).status, 204);
    assert.equal(w.crm.getLead(lead.id)!.smsStatus, "DELIVERED");
    assert.equal(w.crm.getCommunication(communication.id)!.status, "DELIVERED");
    await s.twilioPost("/api/webhooks/twilio/status", { MessageSid: sid, MessageStatus: "sent" });
    assert.equal(w.crm.getLead(lead.id)!.smsStatus, "DELIVERED", "never regresses");
    await s.twilioPost("/api/webhooks/twilio/status", { MessageSid: sid, MessageStatus: "undelivered", ErrorCode: "21610" });
    assert.equal(w.crm.getLead(lead.id)!.smsOptOut, true);
  } finally {
    await s.close();
  }
});

test("Twilio webhooks fail closed when TWILIO_AUTH_TOKEN is missing", async () => {
  const cfg = testConfig();
  cfg.twilioAuthToken = "";
  const w = world({ cfg });
  const s = await serve(w);
  try {
    const r = await s.call("POST", "/api/webhooks/twilio/incoming", "From=%2B15125550100&Body=STOP", { "Content-Type": "application/x-www-form-urlencoded" });
    assert.equal(r.status, 503);
  } finally {
    await s.close();
  }
});

test("POST /webhooks/resend: verified events update email_status; unsigned requests are refused", async () => {
  const w = world();
  const lead = w.addLead();
  const { communication } = await sendLeadEmail({ leadId: lead.id, email: lead.email!, subject: "s", body: "b" }, w.deps);
  const s = await serve(w);
  const sign = (body: string) => {
    const id = "msg_" + Math.random().toString(36).slice(2);
    const ts = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(w.cfg.resendWebhookSecret.replace(/^whsec_/, ""), "base64");
    return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}` };
  };
  try {
    const delivered = JSON.stringify({ type: "email.delivered", data: { email_id: communication.providerMessageId } });
    assert.equal((await s.call("POST", "/webhooks/resend", delivered)).status, 401);
    assert.equal(w.crm.getLead(lead.id)!.emailStatus, "SENT");
    assert.equal((await s.call("POST", "/webhooks/resend", delivered, sign(delivered))).status, 200);
    assert.equal(w.crm.getLead(lead.id)!.emailStatus, "DELIVERED");
    const complained = JSON.stringify({ type: "email.complained", data: { email_id: communication.providerMessageId } });
    await s.call("POST", "/webhooks/resend", complained, sign(complained));
    const after = w.crm.getLead(lead.id)!;
    assert.equal(after.emailStatus, "COMPLAINED");
    assert.equal(after.emailOptOut, true);
  } finally {
    await s.close();
  }
});

test("send routes: preview, confirmed send, rejection codes, preferences — and no secrets in responses", async () => {
  const cfg = testConfig();
  cfg.resendApiKey = "re_SUPER_SECRET_KEY";
  cfg.twilioAuthToken = "TWILIO_SECRET_TOKEN";
  const w = world({ cfg });
  const lead = w.addLead();
  const s = await serve(w);
  const bodies: string[] = [];
  const call = async (...a: Parameters<typeof s.call>) => {
    const r = await s.call(...a);
    bodies.push(r.text);
    return r;
  };
  try {
    const preview = await call("GET", `/api/leads/${lead.id}/send-preview`);
    assert.equal(preview.status, 200);
    const pe = preview.body.email as Record<string, unknown>;
    const ps = preview.body.sms as Record<string, unknown>;
    assert.equal(pe.ok, true);
    assert.equal(pe.to, "joe@joesplumbing.com");
    assert.equal(pe.from, '"Keystone Web Agency" <hello@keystone.test>');
    assert.match(String(pe.footer), /Unsubscribe/);
    assert.equal(ps.ok, false);
    assert.equal(ps.code, "NO_SMS_CONSENT");
    assert.equal(ps.to, "+15125550100");

    const sent = await call("POST", `/api/leads/${lead.id}/email/send`, { email: "joe@joesplumbing.com", subject: "Hello Joe", body: "Hi Joe", idempotencyKey: "abcdef123456" });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.provider, "RESEND");
    assert.equal(sent.body.recipient, "joe@joesplumbing.com");
    assert.equal((sent.body.lead as Record<string, unknown>).emailStatus, "SENT");
    const dup = await call("POST", `/api/leads/${lead.id}/email/send`, { email: "joe@joesplumbing.com", subject: "Hello Joe", body: "Hi Joe", idempotencyKey: "abcdef123456" });
    assert.equal(dup.body.duplicate, true);
    assert.equal(w.resend.calls.length, 1);

    const sms = await call("POST", `/api/leads/${lead.id}/sms/send`, { phone: "+15125550100", message: "Hi" });
    assert.equal(sms.status, 422);
    assert.equal(sms.body.code, "NO_SMS_CONSENT");

    const prefs = await call("PATCH", `/api/leads/${lead.id}/contact-preferences`, { smsConsent: true });
    assert.equal(prefs.status, 200);
    const sms2 = await call("POST", `/api/leads/${lead.id}/sms/send`, { phone: "+15125550100", message: "Hi Joe" });
    assert.equal(sms2.status, 200);
    assert.equal(sms2.body.provider, "TWILIO");

    assert.equal((await call("PATCH", `/api/leads/${lead.id}/contact-preferences`, { emailOptOut: true })).status, 200);
    const blocked = await call("POST", `/api/leads/${lead.id}/email/send`, { email: "joe@joesplumbing.com", subject: "Again", body: "Hi" });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.code, "EMAIL_OPT_OUT");
    assert.equal((await call("PATCH", `/api/leads/${lead.id}/contact-preferences`, { emailOptOut: "nope" })).status, 400);
    assert.equal((await call("PATCH", `/api/leads/${lead.id}/contact-preferences`, { status: "new" })).status, 400, "unknown fields rejected");
    assert.equal((await call("POST", `/api/leads/9999/email/send`, { email: "a@b.co", subject: "s", body: "b" })).status, 404);
    assert.equal((await call("POST", `/api/leads/${lead.id}/email/send`, { email: "joe@joesplumbing.com", subject: "", body: "b" })).status, 400);

    const detail = await call("GET", `/api/leads/${lead.id}`);
    const comms = detail.body.communications as { direction: string; channel: string; provider: string }[];
    assert.deepEqual(comms.map((c) => `${c.direction}/${c.channel}/${c.provider}`), ["OUTBOUND/EMAIL/RESEND", "OUTBOUND/SMS/TWILIO"]);

    for (const b of bodies) {
      assert.ok(!b.includes("re_SUPER_SECRET_KEY") && !b.includes("TWILIO_SECRET_TOKEN") && !b.includes("test-secret"), "no secrets in responses");
    }
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- migration

test("migration: old messages table and opted_out flag carry over", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "keystone-mig-"));
  const file = path.join(dir, "old.db");
  try {
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE leads (id INTEGER PRIMARY KEY AUTOINCREMENT, business_name TEXT NOT NULL, contact_name TEXT, email TEXT, phone TEXT, website TEXT,
        industry TEXT, city TEXT, address TEXT, source TEXT NOT NULL, source_id TEXT, rating REAL, review_count INTEGER, audit_json TEXT, score INTEGER,
        status TEXT NOT NULL DEFAULT 'new', sms_consent INTEGER NOT NULL DEFAULT 0, opted_out INTEGER NOT NULL DEFAULT 0, notes TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, email_subject TEXT NOT NULL, email_body TEXT NOT NULL,
        sms_body TEXT NOT NULL, reasoning TEXT NOT NULL DEFAULT '', approved INTEGER NOT NULL DEFAULT 0, decision TEXT, created_at TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, draft_id INTEGER, channel TEXT NOT NULL, direction TEXT NOT NULL,
        provider TEXT NOT NULL, provider_id TEXT, recipient TEXT, subject TEXT, body TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, type TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE suppressions (value TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT 'x');
      INSERT INTO leads (business_name, email, phone, source, status, opted_out) VALUES ('A', 'a@a.com', '+15125550100', 'csv', 'sent', 0), ('B', 'b@b.com', '+15125550101', 'csv', 'opted_out', 1);
      INSERT INTO messages (lead_id, channel, direction, provider, provider_id, recipient, subject, body, status, created_at)
        VALUES (1, 'email', 'outbound', 'resend', 're_1', 'a@a.com', 'Hi', 'Body', 'delivered', '2026-01-01T00:00:00.000Z'),
               (1, 'sms', 'inbound', 'twilio', 'SM1', NULL, NULL, 'Yes please', 'received', '2026-01-02T00:00:00.000Z'),
               (1, 'email', 'outbound', 'dryrun-email', 'dry-1', 'a@a.com', 'Hi', 'Body', 'failed', '2026-01-03T00:00:00.000Z');
    `);
    old.close();

    const crm = new CRM(file);
    const [a, b] = [crm.getLead(1)!, crm.getLead(2)!];
    assert.deepEqual([b.emailOptOut, b.smsOptOut, b.doNotContact], [true, true, true], "old opt-out means never contact");
    assert.deepEqual([a.emailOptOut, a.smsOptOut, a.doNotContact], [false, false, false]);
    assert.equal(a.replied, true);
    assert.equal(a.lastContactedAt, "2026-01-01T00:00:00.000Z");
    const comms = crm.communicationsForLead(1);
    assert.deepEqual(
      comms.map((c) => [c.direction, c.channel, c.provider, c.providerMessageId, c.status, c.sentAt]),
      [
        ["OUTBOUND", "EMAIL", "RESEND", "re_1", "DELIVERED", "2026-01-01T00:00:00.000Z"],
        ["INBOUND", "SMS", "TWILIO", "SM1", "RECEIVED", "2026-01-02T00:00:00.000Z"],
        ["OUTBOUND", "EMAIL", "DRY_RUN", "dry-1", "FAILED", null],
      ],
    );
    assert.ok(!crm.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages'").get(), "old table dropped");
    crm.close();

    // Re-opening is a no-op.
    const again = new CRM(file);
    assert.equal(again.communicationsForLead(1).length, 3);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
