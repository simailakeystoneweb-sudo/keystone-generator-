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

export type Channel = "email" | "sms";
export type MessageStatus = "queued" | "sent" | "delivered" | "failed" | "bounced" | "received";

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
  audit: WebsiteAudit | null;
  score: number | null;
  status: LeadStatus;
  smsConsent: boolean;
  optedOut: boolean;
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

export interface OutboundMessage {
  id: number;
  leadId: number;
  draftId: number | null;
  channel: Channel;
  direction: "outbound" | "inbound";
  provider: string;
  providerId: string | null;
  to: string | null;
  subject: string | null;
  body: string;
  status: MessageStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
