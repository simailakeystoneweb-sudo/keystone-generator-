import type { Config } from "../config.js";
import type { Lead } from "../types.js";
import {
  ClaudeService,
  type AnalyzeLeadInput,
  type LeadAnalysis,
  type ReplyClassification,
} from "./claude.js";

export type { ReplyClassification } from "./claude.js";

export interface Outreach {
  emailSubject: string;
  emailBody: string;
  smsBody: string;
  reasoning: string;
}

/** What the pipeline needs from the AI; swap in a fake for tests. */
export interface Personalizer {
  draft(lead: Lead): Promise<Outreach>;
  classifyReply(lead: Lead, reply: string, channel: "email" | "sms"): Promise<ReplyClassification>;
}

export function createClaudeService(cfg: Config): ClaudeService {
  return new ClaudeService({
    apiKey: process.env.ANTHROPIC_API_KEY || undefined,
    model: cfg.anthropicModel,
    effort: cfg.anthropicEffort,
    agency: {
      agencyName: cfg.sender.company,
      senderName: cfg.sender.name,
      senderTitle: cfg.sender.title,
      offer: cfg.sender.offer,
      bookingUrl: cfg.sender.bookingUrl,
    },
  });
}

/** Build the Claude input for a CRM lead from what we've stored about it. */
export function leadToInput(lead: Lead, overrides: Partial<AnalyzeLeadInput> = {}): AnalyzeLeadInput & { contactName: string } {
  const issues = (lead.audit?.findings ?? []).map((f) => f.detail);
  return {
    businessName: lead.businessName,
    website: lead.website ?? "",
    industry: lead.industry ?? "",
    city: lead.city ?? "",
    description: lead.description ?? "",
    knownWebsiteIssues: issues,
    notes: lead.notes ?? "",
    contactName: lead.contactName ?? "",
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  };
}

/** Pipeline adapter over ClaudeService: one email + one SMS per lead, plus reply triage. */
export class ClaudePersonalizer implements Personalizer {
  constructor(private claude: ClaudeService) {}

  async draft(lead: Lead): Promise<Outreach> {
    const analysis: LeadAnalysis | undefined = lead.analysis ?? undefined;
    const input = { lead: leadToInput(lead), analysis };
    const [email, sms] = await Promise.all([this.claude.generateColdEmail(input), this.claude.generateColdSMS(input)]);
    return { emailSubject: email.subject, emailBody: email.body, smsBody: sms.message, reasoning: analysis?.reasonForContacting ?? "" };
  }

  classifyReply(lead: Lead, reply: string, channel: "email" | "sms"): Promise<ReplyClassification> {
    return this.claude.classifyReply({
      replyText: reply,
      channel: channel === "email" ? "EMAIL" : "SMS",
      businessName: lead.businessName,
    });
  }
}
