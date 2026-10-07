import type { CommProvider } from "../types.js";
import type { SendResult } from "./email.js";

export interface SmsMessage {
  from?: string;
  to: string;
  body: string;
  statusCallback: string;
  leadId: number;
}

/** A transport that delivers one SMS. Lead checks and CRM records live in sendLeadSMS. */
export interface SmsSender {
  readonly provider: CommProvider;
  send(msg: SmsMessage): Promise<SendResult>;
}

/** Raised by a sender when the provider rejects the SMS. `code` is the Twilio error code when known. */
export class SmsProviderError extends Error {
  constructor(message: string, readonly code: number | null = null, readonly status: number | null = null) {
    super(message);
    this.name = "SmsProviderError";
  }
}

export const SMS_OPT_OUT = "Reply STOP to opt out.";

/** Every outreach text carries opt-out instructions (CTIA guidelines). */
export function composeSms(body: string): string {
  const b = body.trim();
  return /reply stop/i.test(b) ? b : `${b} ${SMS_OPT_OUT}`;
}

/** DRY_RUN=true: logs instead of delivering. Records are stored with provider DRY_RUN. */
export class DryRunSmsSender implements SmsSender {
  readonly provider = "DRY_RUN" as const;
  readonly sent: SmsMessage[] = [];
  async send(msg: SmsMessage): Promise<SendResult> {
    this.sent.push(msg);
    console.log(`[dry-run] sms → ${msg.to}: ${msg.body}`);
    return { provider: this.provider, providerMessageId: `dry-sms-${Date.now()}-${this.sent.length}` };
  }
}
