/**
 * CRM pipeline stages, in order. A lead only ever moves forward through the
 * outreach stages (sent → delivered → replied → interested → booked → closed);
 * terminal side-stages (lost, opted_out, bounced) can be reached from anywhere.
 */
export const PIPELINE = [
  "new",
  "enriched",
  "drafted",
  "pending_approval",
  "approved",
  "sent",
  "delivered",
  "replied",
  "interested",
  "booked",
  "closed",
] as const;

export const SIDE_STAGES = ["skipped", "lost", "opted_out", "bounced"] as const;

export type PipelineStage = (typeof PIPELINE)[number];
export type SideStage = (typeof SIDE_STAGES)[number];
export type LeadStatus = PipelineStage | SideStage;

/** Pipeline-level channel name (rules, scheduling). */
export type Channel = "email" | "sms";

// ---------- communications (stored with these exact uppercase values) ----------

export type CommDirection = "OUTBOUND" | "INBOUND";
export type CommChannel = "EMAIL" | "SMS";
export type CommProvider = "RESEND" | "GMAIL" | "TWILIO" | "DRY_RUN" | "MANUAL" | "INBOUND_HOOK";
export type CommStatus = "QUEUED" | "SENT" | "DELIVERED" | "FAILED" | "BOUNCED" | "RECEIVED";

export const toCommChannel = (c: Channel): CommChannel => (c === "email" ? "EMAIL" : "SMS");
export const fromCommChannel = (c: CommChannel): Channel => (c === "EMAIL" ? "email" : "sms");

/** Per-channel delivery state on the lead. null = never sent on this channel. */
export type EmailStatus = "SENT" | "DELIVERED" | "BOUNCED" | "COMPLAINED";
export type SmsStatus = "SENT" | "DELIVERED" | "FAILED" | "UNDELIVERED";

export interface ReplyClassificationRecord {
  classification: string;
  sentiment: string;
  recommendedAction: string;
  shouldPauseSequence: boolean;
  /** "keyword" for compliance keywords (STOP, HELP…), "claude" for AI triage. */
  source: "keyword" | "claude";
  classifiedAt: string;
}

export interface Communication {
  id: number;
  leadId: number;
  draftId: number | null;
  campaignId: string | null;
  direction: CommDirection;
  channel: CommChannel;
  provider: CommProvider;
  providerMessageId: string | null;
  /** Recipient address/number for outbound; our address/number for inbound. */
  recipient: string | null;
  /** Our from-address/number for outbound; the lead's address/number for inbound. */
  sender: string | null;
  subject: string | null;
  body: string;
  status: CommStatus;
  error: string | null;
  classification: ReplyClassificationRecord | null;
  /** When the provider accepted it (outbound) or we received it (inbound). */
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadAnalysisRecord {
  leadScore: number;
  websiteScore: number;
  quality: "LOW" | "MEDIUM" | "HIGH";
  summary: string;
  painPoints: string[];
  recommendedOffer: string;
  recommendedChannel: "EMAIL" | "SMS" | "BOTH";
  reasonForContacting: string;
  analyzedAt?: string;
}

export interface WebsiteFinding {
  kind: "problem" | "opportunity";
  code: string;
  detail: string;
}

export interface WebsiteAudit {
  url: string;
  reachable: boolean;
  https: boolean;
  loadMs: number | null;
  pageKb: number | null;
  title: string | null;
  metaDescription: string | null;
  findings: WebsiteFinding[];
}

export interface RawBusiness {
  businessName: string;
  phone?: string | null;
  website?: string | null;
  industry?: string | null;
  city?: string | null;
  address?: string | null;
  source: string;
  sourceId?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
}

export interface Lead {
  id: number;
  businessName: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  industry: string | null;
  city: string | null;
  address: string | null;
  source: string;
  sourceId: string | null;
  rating: number | null;
  reviewCount: number | null;
  /** Free-text description of the business (from the user or the source). */
  description: string | null;
  audit: WebsiteAudit | null;
  /** Latest Claude lead analysis, if one has been run. */
  analysis: LeadAnalysisRecord | null;
  score: number | null;
  status: LeadStatus;
  smsConsent: boolean;
  /** Contact preferences. Only a manual change clears these once set. */
  emailOptOut: boolean;
  smsOptOut: boolean;
  doNotContact: boolean;
  emailStatus: EmailStatus | null;
  smsStatus: SmsStatus | null;
  lastContactedAt: string | null;
  /** The lead has replied on any channel. */
  replied: boolean;
  /** Automated follow-ups are paused (set on any reply). */
  sequencePaused: boolean;
  lastReplyClassification: ReplyClassificationRecord | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Draft {
  id: number;
  leadId: number;
  emailSubject: string;
  emailBody: string;
  smsBody: string;
  reasoning: string;
  approved: boolean;
  decision: string | null;
  createdAt: string;
}
