import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type { Fetch } from "../leads/finder.js";
import type { SendResult } from "./email.js";

export interface SmsMessage {
  to: string;
  body: string;
  statusCallback: string;
  leadId: number;
}

export interface SmsSender {
  readonly name: string;
  send(msg: SmsMessage): Promise<SendResult>;
}

export const SMS_OPT_OUT = "Reply STOP to opt out.";

export function composeSms(body: string): string {
  const b = body.trim();
  return /reply stop/i.test(b) ? b : `${b} ${SMS_OPT_OUT}`;
}

export class TwilioSender implements SmsSender {
  readonly name = "twilio";
  constructor(private cfg: Config, private fetchImpl: Fetch = fetch) {}

  async send(msg: SmsMessage): Promise<SendResult> {
    const form = new URLSearchParams({ To: msg.to, Body: msg.body, StatusCallback: msg.statusCallback });
    if (this.cfg.twilioMessagingServiceSid) form.set("MessagingServiceSid", this.cfg.twilioMessagingServiceSid);
    else form.set("From", this.cfg.twilioFromNumber);
    const auth = Buffer.from(`${this.cfg.twilioAccountSid}:${this.cfg.twilioAuthToken}`).toString("base64");
    const res = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.cfg.twilioAccountSid)}/Messages.json`,
      { method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form },
    );
    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${data.message ?? "send failed"}`);
    return { provider: this.name, providerId: data.sid ?? null };
  }
}

export class DryRunSmsSender implements SmsSender {
  readonly name = "dryrun-sms";
  readonly sent: SmsMessage[] = [];
  async send(msg: SmsMessage): Promise<SendResult> {
    this.sent.push(msg);
    console.log(`[dry-run] sms → ${msg.to}: ${msg.body}`);
    return { provider: this.name, providerId: `dry-sms-${Date.now()}-${this.sent.length}` };
  }
}

export function createSmsSender(cfg: Config): SmsSender | null {
  if (cfg.dryRun) return new DryRunSmsSender();
  if (!cfg.twilioAccountSid || !cfg.twilioAuthToken) return null;
  if (!cfg.twilioFromNumber && !cfg.twilioMessagingServiceSid)
    throw new Error("Twilio needs TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID");
  return new TwilioSender(cfg);
}

/**
 * Validate the X-Twilio-Signature header: base64(HMAC-SHA1(authToken, url + sorted key/value pairs)).
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!authToken || !signature) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  const expected = createHmac("sha1", authToken).update(data).digest();
  const got = Buffer.from(signature, "base64");
  return got.length === expected.length && timingSafeEqual(got, expected);
}
