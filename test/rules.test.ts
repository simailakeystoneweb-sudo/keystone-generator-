import { test } from "node:test";
import assert from "node:assert/strict";
import { decideApproval, inSendWindow, sendBlocker, startOfLocalDayIso } from "../src/rules.js";
import { canTransition, normalizePhone } from "../src/crm/db.js";
import type { Lead } from "../src/types.js";
import { testConfig } from "./helpers.js";

const lead = (over: Partial<Lead> = {}): Lead => ({
  id: 1, businessName: "Joe's", contactName: "Joe", email: "joe@joes.com", phone: "+15125550100", website: "joes.com",
  industry: "Plumber", city: "Austin", address: null, source: "csv", sourceId: null, rating: 4.5, reviewCount: 30,
  audit: null, analysis: null, description: null, score: 80, status: "drafted", smsConsent: false,
  emailOptOut: false, smsOptOut: false, doNotContact: false, emailStatus: null, smsStatus: null, lastContactedAt: null,
  replied: false, sequencePaused: false, lastReplyClassification: null, notes: null, createdAt: "", updatedAt: "",
  ...over,
});
const none = () => false;

test("approval: auto mode approves high-score leads with email", () => {
  const r = testConfig().rules;
  assert.equal(decideApproval(lead(), r, none).action, "auto_approve");
  assert.equal(decideApproval(lead({ score: 40 }), r, none).action, "needs_approval");
  assert.equal(decideApproval(lead({ email: null }), r, none).action, "needs_approval");
  assert.equal(decideApproval(lead({ score: 5 }), r, none).action, "skip");
});

test("approval: manual mode always queues; blocks always skip", () => {
  const r = testConfig({ approvalMode: "manual", blockedIndustries: ["cannabis"], blockedDomains: ["gov"] }).rules;
  assert.equal(decideApproval(lead(), r, none).action, "needs_approval");
  assert.equal(decideApproval(lead({ industry: "Cannabis Dispensary" }), r, none).action, "skip");
  assert.equal(decideApproval(lead({ email: "x@city.gov" }), r, none).action, "skip");
  assert.equal(decideApproval(lead({ doNotContact: true }), r, none).action, "skip");
  assert.equal(decideApproval(lead({ emailOptOut: true, smsOptOut: true }), r, none).action, "skip");
  assert.equal(decideApproval(lead({ emailOptOut: true }), r, none).action, "needs_approval", "SMS still possible, but needs review");
  assert.equal(decideApproval(lead(), r, (v) => v === "joe@joes.com" || v === "+15125550100").action, "skip");
});

test("send window respects timezone and weekends", () => {
  const r = testConfig({ sendWindowStart: 9, sendWindowEnd: 17, sendOnWeekends: false, timezone: "America/New_York" }).rules;
  assert.equal(inSendWindow(new Date("2026-10-07T14:00:00Z"), r), true); // Wed 10:00 EDT
  assert.equal(inSendWindow(new Date("2026-10-07T23:00:00Z"), r), false); // Wed 19:00 EDT
  assert.equal(inSendWindow(new Date("2026-10-10T14:00:00Z"), r), false); // Saturday
});

test("startOfLocalDayIso", () => {
  assert.equal(startOfLocalDayIso(new Date("2026-10-07T14:30:15.250Z"), "UTC"), "2026-10-07T00:00:00.000Z");
  assert.equal(startOfLocalDayIso(new Date("2026-10-07T14:30:00Z"), "America/New_York"), "2026-10-07T04:00:00.000Z");
});

test("sms needs consent and waits for the email delay", () => {
  const r = testConfig().rules;
  const now = new Date("2026-10-07T12:00:00Z");
  const ctx = { now, sentToday: { email: 0, sms: 0 }, isSuppressed: none, firstEmailAt: null, alreadySent: { email: false, sms: false }, repliedOrBeyond: false };
  assert.match(sendBlocker("sms", lead(), r, ctx)!, /consent/);
  assert.match(sendBlocker("sms", lead({ smsConsent: true }), r, ctx)!, /email to go out first/);
  assert.match(sendBlocker("sms", lead({ smsConsent: true }), r, { ...ctx, firstEmailAt: new Date("2026-10-06T12:00:00Z") })!, /scheduled/);
  assert.equal(sendBlocker("sms", lead({ smsConsent: true }), r, { ...ctx, firstEmailAt: new Date("2026-10-05T11:00:00Z") }), null);
  assert.equal(sendBlocker("email", lead(), r, ctx), null);
  assert.match(sendBlocker("email", lead(), r, { ...ctx, sentToday: { email: 100, sms: 0 } })!, /limit/);
  assert.match(sendBlocker("email", lead(), r, { ...ctx, repliedOrBeyond: true })!, /replied/);
});

test("pipeline transitions only move forward", () => {
  assert.equal(canTransition("sent", "delivered"), true);
  assert.equal(canTransition("replied", "delivered"), false);
  assert.equal(canTransition("booked", "lost"), true);
  assert.equal(canTransition("opted_out", "interested"), false);
  assert.equal(canTransition("lost", "interested"), false);
});

test("normalizePhone", () => {
  assert.equal(normalizePhone("(512) 555-0100"), "+15125550100");
  assert.equal(normalizePhone("1-512-555-0100"), "+15125550100");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("123"), null);
});
