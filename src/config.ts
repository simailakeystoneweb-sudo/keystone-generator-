import { readFileSync, existsSync } from "node:fs";

/** Minimal .env loader so the project has no dotenv dependency. Existing env vars win. */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const str = (k: string, d = ""): string => process.env[k] ?? d;
const num = (k: string, d: number): number => {
  const v = process.env[k];
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (k: string, d: boolean): boolean => {
  const v = process.env[k];
  if (v === undefined || v === "") return d;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
};

export type EmailProvider = "resend" | "gmail" | "none";

export interface Config {
  dbPath: string;
  publicBaseUrl: string;
  port: number;
  dashboardToken: string;
  /** Signs unsubscribe links. */
  appSecret: string;
  dryRun: boolean;
  /** Set when running behind a reverse proxy so req.ip is the real client. */
  trustProxy: boolean;
  /** Max AI requests per client per minute (0 = unlimited). */
  aiRateLimitPerMinute: number;
  /** Max email/SMS send requests per client per minute (0 = unlimited). */
  sendRateLimitPerMinute: number;

  googlePlacesApiKey: string;
  hunterApiKey: string;

  anthropicModel: string;
  anthropicEffort: "low" | "medium" | "high" | "xhigh" | "max";

  sender: {
    name: string;
    company: string;
    title: string;
    offer: string;
    bookingUrl: string;
    physicalAddress: string;
  };

  emailProvider: EmailProvider;
  /** OUTREACH_FROM_EMAIL — the address outreach is sent from (must be on a domain verified in Resend). */
  outreachFromEmail: string;
  /** OUTREACH_FROM_NAME — display name, default "Keystone Web Agency". */
  outreachFromName: string;
  /** Formatted From header derived from the two above (or legacy EMAIL_FROM). */
  emailFrom: string;
  emailReplyTo: string;
  resendApiKey: string;
  resendWebhookSecret: string;
  gmailUser: string;
  gmailAppPassword: string;

  twilioAccountSid: string;
  twilioAuthToken: string;
  /** TWILIO_PHONE_NUMBER (E.164). Legacy TWILIO_FROM_NUMBER is still read as a fallback. */
  twilioPhoneNumber: string;
  twilioMessagingServiceSid: string;
  twilioValidateSignature: boolean;
  /** Never send SMS between these local hours (TCPA quiet hours: before 8am / after 9pm). */
  smsQuietHoursStart: number;
  smsQuietHoursEnd: number;

  rules: RulesConfig;
}

export interface RulesConfig {
  /** "manual": everything waits in the approval queue. "auto": rules decide. */
  approvalMode: "manual" | "auto";
  /** In auto mode, leads with a fit score at/above this are auto-approved. */
  autoApproveMinScore: number;
  /** Below this score, leads are skipped entirely. */
  minScore: number;
  dailyEmailLimit: number;
  dailySmsLimit: number;
  /** Local-time sending window, 24h clock, in `timezone`. */
  sendWindowStart: number;
  sendWindowEnd: number;
  sendOnWeekends: boolean;
  timezone: string;
  /** TCPA: never text a lead without recorded consent unless explicitly disabled. */
  smsRequireConsent: boolean;
  /** Only send SMS to leads that have already been emailed and not replied after N days (0 = same time). */
  smsDelayDays: number;
  blockedDomains: string[];
  blockedIndustries: string[];
}

export function loadConfig(): Config {
  return {
    dbPath: str("DB_PATH", "keystone.db"),
    publicBaseUrl: str("PUBLIC_BASE_URL", "http://localhost:3000").replace(/\/$/, ""),
    port: num("PORT", 3000),
    dashboardToken: str("DASHBOARD_TOKEN"),
    appSecret: str("APP_SECRET", "change-me"),
    trustProxy: bool("TRUST_PROXY", false),
    aiRateLimitPerMinute: num("AI_RATE_LIMIT_PER_MINUTE", 20),
    sendRateLimitPerMinute: num("SEND_RATE_LIMIT_PER_MINUTE", 10),
    dryRun: bool("DRY_RUN", true),

    googlePlacesApiKey: str("GOOGLE_PLACES_API_KEY"),
    hunterApiKey: str("HUNTER_API_KEY"),

    anthropicModel: str("ANTHROPIC_MODEL", "claude-opus-5-5"),
    anthropicEffort: (str("ANTHROPIC_EFFORT", "medium") as Config["anthropicEffort"]),

    sender: {
      name: str("SENDER_NAME", "Alex"),
      company: str("SENDER_COMPANY", "Keystone Web Agency"),
      title: str("SENDER_TITLE", "Founder"),
      offer: str(
        "SENDER_OFFER",
        "We build fast, mobile-friendly websites for local businesses that turn visitors into booked calls.",
      ),
      bookingUrl: str("BOOKING_URL"),
      physicalAddress: str("SENDER_PHYSICAL_ADDRESS"),
    },

    emailProvider: (str("EMAIL_PROVIDER", "resend") as EmailProvider),
    outreachFromEmail: str("OUTREACH_FROM_EMAIL"),
    outreachFromName: str("OUTREACH_FROM_NAME", "Keystone Web Agency"),
    emailFrom: formatFrom(str("OUTREACH_FROM_NAME", "Keystone Web Agency"), str("OUTREACH_FROM_EMAIL")) || str("EMAIL_FROM"),
    emailReplyTo: str("EMAIL_REPLY_TO"),
    resendApiKey: str("RESEND_API_KEY"),
    resendWebhookSecret: str("RESEND_WEBHOOK_SECRET"),
    gmailUser: str("GMAIL_USER"),
    gmailAppPassword: str("GMAIL_APP_PASSWORD"),

    twilioAccountSid: str("TWILIO_ACCOUNT_SID"),
    twilioAuthToken: str("TWILIO_AUTH_TOKEN"),
    twilioPhoneNumber: str("TWILIO_PHONE_NUMBER") || str("TWILIO_FROM_NUMBER"),
    twilioMessagingServiceSid: str("TWILIO_MESSAGING_SERVICE_SID"),
    twilioValidateSignature: bool("TWILIO_VALIDATE_SIGNATURE", true),
    smsQuietHoursStart: num("SMS_QUIET_HOURS_START", 21),
    smsQuietHoursEnd: num("SMS_QUIET_HOURS_END", 8),

    rules: {
      approvalMode: str("APPROVAL_MODE", "manual") === "auto" ? "auto" : "manual",
      autoApproveMinScore: num("AUTO_APPROVE_MIN_SCORE", 70),
      minScore: num("MIN_SCORE", 30),
      dailyEmailLimit: num("DAILY_EMAIL_LIMIT", 50),
      dailySmsLimit: num("DAILY_SMS_LIMIT", 25),
      sendWindowStart: num("SEND_WINDOW_START", 9),
      sendWindowEnd: num("SEND_WINDOW_END", 17),
      sendOnWeekends: bool("SEND_ON_WEEKENDS", false),
      timezone: str("TIMEZONE", "America/New_York"),
      smsRequireConsent: bool("SMS_REQUIRE_CONSENT", true),
      smsDelayDays: num("SMS_DELAY_DAYS", 2),
      blockedDomains: str("BLOCKED_DOMAINS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
      blockedIndustries: str("BLOCKED_INDUSTRIES").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    },
  };
}

/**
 * Build a From header: `"Keystone Web Agency" <hello@example.com>`. The display name is
 * stripped of characters that could break or inject into the header.
 */
export function formatFrom(name: string, email: string): string {
  const addr = email.trim();
  if (!addr) return "";
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(addr)) throw new Error(`OUTREACH_FROM_EMAIL is not a valid email address: ${addr}`);
  const display = name.replace(/[\r\n"<>\\]/g, "").trim();
  return display ? `"${display}" <${addr}>` : addr;
}
