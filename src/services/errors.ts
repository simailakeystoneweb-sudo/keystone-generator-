import type { CRM } from "../crm/db.js";

/** Why a send was refused before reaching the provider. */
export type RejectCode =
  | "INVALID_INPUT"
  | "LEAD_NOT_FOUND"
  | "NO_EMAIL"
  | "EMAIL_MISMATCH"
  | "EMAIL_OPT_OUT"
  | "DO_NOT_CONTACT"
  | "SUPPRESSED"
  | "INVALID_PHONE"
  | "PHONE_MISMATCH"
  | "SMS_OPT_OUT"
  | "NO_SMS_CONSENT"
  | "QUIET_HOURS"
  | "SEND_IN_PROGRESS"
  | "NOT_CONFIGURED";

const HTTP_STATUS: Partial<Record<RejectCode, number>> = {
  INVALID_INPUT: 400,
  LEAD_NOT_FOUND: 404,
  SEND_IN_PROGRESS: 409,
  NOT_CONFIGURED: 503,
};

/** The lead can't be contacted (or the request is invalid). Nothing was sent. */
export class SendRejectedError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: RejectCode, message: string) {
    super(message);
    this.name = "SendRejectedError";
    this.httpStatus = HTTP_STATUS[code] ?? 422;
  }
}

/** The provider (Resend/Twilio) refused or failed the send. A FAILED communication was recorded. */
export class ProviderSendError extends Error {
  readonly httpStatus = 502;
  constructor(
    message: string,
    readonly provider: string,
    readonly providerCode: string | number | null,
    readonly communicationId: number | null,
  ) {
    super(message);
    this.name = "ProviderSendError";
  }
}

export interface Contactability {
  ok: boolean;
  code: RejectCode | null;
  message: string;
}

export const contactable = (): Contactability => ({ ok: true, code: null, message: "OK" });
export const notContactable = (code: RejectCode, message: string): Contactability => ({ ok: false, code, message });

/**
 * One send per lead per channel at a time, so a double-click or two open tabs can't
 * send twice. Scoped to the CRM instance (one per database).
 */
const inFlight = new WeakMap<CRM, Set<string>>();

export async function withSendLock<T>(crm: CRM, key: string, fn: () => Promise<T>): Promise<T> {
  let set = inFlight.get(crm);
  if (!set) inFlight.set(crm, (set = new Set()));
  if (set.has(key)) throw new SendRejectedError("SEND_IN_PROGRESS", "A send to this lead is already in progress.");
  set.add(key);
  try {
    return await fn();
  } finally {
    set.delete(key);
  }
}
