import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { CRM } from "./crm/db.js";
import { auditWebsite, scoreLead } from "./leads/audit.js";
import { findContact } from "./leads/enrich.js";
import { searchGooglePlaces, type Fetch, type ImportedRow, type SearchQuery } from "./leads/finder.js";
import { isOptOut, leadToInput, type Personalizer, type ReplyClassification } from "./ai/personalize.js";
import type { AnalyzeLeadInput, ClaudeService, ColdEmail, ColdSms, FollowUp } from "./ai/claude.js";
import { composeEmail, type EmailSender } from "./channels/email.js";
import { composeSms, type SmsSender } from "./channels/sms.js";
import { decideApproval, sendBlocker, startOfLocalDayIso } from "./rules.js";
import type { Channel, Lead, LeadStatus, MessageStatus } from "./types.js";
import { PIPELINE } from "./types.js";

export interface PipelineDeps {
  cfg: Config;
  crm: CRM;
  personalizer: Personalizer | null;
  /** Server-side Claude service behind the Lead Details AI buttons. */
  claude?: ClaudeService | null;
  email: EmailSender | null;
  sms: SmsSender | null;
  fetchImpl?: Fetch;
  now?: () => Date;
}

const stageIndex = (s: LeadStatus) => PIPELINE.indexOf(s as (typeof PIPELINE)[number]);

/**
 * The whole flow:
 *   find → enrich (contact + website audit + score) → AI draft → approval rules
 *   → send email (Resend/Gmail) + SMS (Twilio) → webhooks advance the CRM:
 *   sent → delivered → replied → interested → booked → closed
 */
export class Pipeline {
  readonly crm: CRM;
  private cfg: Config;
  private fetchImpl: Fetch;
  private now: () => Date;

  constructor(private deps: PipelineDeps) {
    this.crm = deps.crm;
    this.cfg = deps.cfg;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  // ---------- 1. Lead generator ----------

  async findLeads(q: SearchQuery): Promise<{ found: number; created: Lead[] }> {
    const businesses = await searchGooglePlaces(q, this.cfg.googlePlacesApiKey, this.fetchImpl);
    const created: Lead[] = [];
    for (const b of businesses) {
      const { lead, created: isNew } = this.crm.upsertBusiness(b);
      if (isNew) created.push(lead);
    }
    return { found: businesses.length, created };
  }

  importRows(rows: ImportedRow[]): Lead[] {
    const created: Lead[] = [];
    for (const r of rows) {
      const { lead, created: isNew } = this.crm.upsertBusiness(r);
      if (!isNew) continue;
      created.push(
        this.crm.updateLead(lead.id, {
          contactName: r.contactName ?? undefined,
          email: r.email?.toLowerCase() ?? undefined,
          smsConsent: r.smsConsent ?? undefined,
        }),
      );
    }
    return created;
  }

  // ---------- 2. Enrich: contact, website problems/opportunities, score ----------

  async enrich(leadId: number): Promise<Lead> {
    const lead = this.mustLead(leadId);
    const { audit, page } = await auditWebsite(lead.website, this.fetchImpl);
    const contact = await findContact(lead.website, page, { hunterApiKey: this.cfg.hunterApiKey, fetchImpl: this.fetchImpl });
    const email = lead.email ?? contact.email;
    const contactName = lead.contactName ?? contact.contactName;
    const phone = lead.phone ?? contact.phone;
    const score = scoreLead({ audit, email, phone, contactName, rating: lead.rating, reviewCount: lead.reviewCount });
    const updated = this.crm.updateLead(leadId, { audit, email, contactName, phone, score });
    this.crm.logEvent(leadId, "lead.enriched", `score ${score}, ${audit.findings.length} findings, email ${email ? "found" : "missing"}`);
    if (lead.status === "new") this.crm.setStatus(leadId, "enriched");
    return this.crm.getLead(updated.id)!;
  }

  // ---------- 3. AI personalization + 4. approval rules ----------

  async draft(leadId: number): Promise<{ lead: Lead; decision: ReturnType<typeof decideApproval> }> {
    if (!this.deps.personalizer) throw new Error("No AI personalizer configured (set ANTHROPIC_API_KEY)");
    let lead = this.mustLead(leadId);
    const isSuppressed = (v: string | null) => this.crm.isSuppressed(v);

    // Don't spend tokens on leads the rules would throw away anyway.
    const pre = decideApproval(lead, this.cfg.rules, isSuppressed);
    if (pre.action === "skip") {
      this.crm.setStatus(leadId, "skipped", pre.reasons.join("; "));
      return { lead: this.mustLead(leadId), decision: pre };
    }

    const out = await this.deps.personalizer.draft(lead);
    const draft = this.crm.saveDraft(leadId, out);
    this.crm.setStatus(leadId, "drafted");
    lead = this.mustLead(leadId);

    const decision = decideApproval(lead, this.cfg.rules, isSuppressed);
    if (decision.action === "auto_approve") {
      this.crm.decideDraft(draft.id, true, `auto: ${decision.reasons.join("; ")}`);
      this.crm.setStatus(leadId, "approved", `auto-approved: ${decision.reasons.join("; ")}`);
    } else if (decision.action === "needs_approval") {
      this.crm.setStatus(leadId, "pending_approval", decision.reasons.join("; "));
    } else {
      this.crm.setStatus(leadId, "skipped", decision.reasons.join("; "));
    }
    return { lead: this.mustLead(leadId), decision };
  }

  approve(leadId: number, edits: { emailSubject?: string; emailBody?: string; smsBody?: string; smsConsent?: boolean } = {}, by = "human"): Lead {
    const lead = this.mustLead(leadId);
    const draft = this.crm.latestDraft(leadId);
    if (!draft) throw new Error(`lead ${leadId} has no draft`);
    if (edits.emailSubject || edits.emailBody || edits.smsBody) this.crm.updateDraft(draft.id, edits);
    if (edits.smsConsent !== undefined) this.crm.updateLead(leadId, { smsConsent: edits.smsConsent });
    this.crm.decideDraft(draft.id, true, `approved by ${by}`);
    if (lead.status !== "approved") this.crm.setStatus(leadId, "approved", `approved by ${by}`, { force: lead.status === "skipped" });
    return this.mustLead(leadId);
  }

  reject(leadId: number, reason = "rejected", by = "human"): Lead {
    const draft = this.crm.latestDraft(leadId);
    if (draft) this.crm.decideDraft(draft.id, false, `${reason} (${by})`);
    this.crm.setStatus(leadId, "skipped", `${reason} (${by})`);
    return this.mustLead(leadId);
  }

  /** Throw away the current draft and ask the AI for a fresh one. */
  async redraft(leadId: number): Promise<Lead> {
    const lead = this.mustLead(leadId);
    if (!["drafted", "pending_approval", "approved", "skipped"].includes(lead.status)) throw new Error(`cannot redraft a lead in status ${lead.status}`);
    this.crm.setStatus(leadId, "enriched", "redraft requested", { force: true });
    return (await this.draft(leadId)).lead;
  }

  // ---------- 5. Send: EMAIL (Resend/Gmail) + TEXT (Twilio) ----------

  /** Send every message that is approved and allowed by the automation rules right now. */
  async sendDue(): Promise<{ sent: { leadId: number; channel: Channel }[]; held: { leadId: number; channel: Channel; reason: string }[] }> {
    const sent: { leadId: number; channel: Channel }[] = [];
    const held: { leadId: number; channel: Channel; reason: string }[] = [];
    const candidates = this.crm.listLeads({ status: ["approved", "sent", "delivered"], limit: 10_000 });
    for (const lead of candidates) {
      const draft = this.crm.latestDraft(lead.id);
      if (!draft?.approved) continue;
      for (const channel of ["email", "sms"] as const) {
        const reason = await this.trySend(lead.id, channel);
        if (reason === null) sent.push({ leadId: lead.id, channel });
        else if (!/already sent|no (email|phone)/.test(reason)) held.push({ leadId: lead.id, channel, reason });
      }
    }
    return { sent, held };
  }

  /** Attempt a single channel for a single lead. Returns null if sent, else the reason it was held. */
  async trySend(leadId: number, channel: Channel): Promise<string | null> {
    const lead = this.mustLead(leadId);
    const draft = this.crm.latestDraft(leadId);
    if (!draft?.approved) return "draft not approved";
    const sender = channel === "email" ? this.deps.email : this.deps.sms;
    if (!sender) return `no ${channel} provider configured`;

    const now = this.now();
    const since = startOfLocalDayIso(now, this.cfg.rules.timezone);
    const history = this.crm.messagesForLead(leadId).filter((m) => m.direction === "outbound" && m.status !== "failed");
    const firstEmail = history.find((m) => m.channel === "email");
    const blocker = sendBlocker(channel, lead, this.cfg.rules, {
      now,
      sentToday: { email: this.crm.countOutboundSince("email", since), sms: this.crm.countOutboundSince("sms", since) },
      isSuppressed: (v) => this.crm.isSuppressed(v),
      firstEmailAt: firstEmail ? new Date(firstEmail.createdAt) : null,
      alreadySent: { email: Boolean(firstEmail), sms: history.some((m) => m.channel === "sms") },
      repliedOrBeyond: stageIndex(lead.status) >= stageIndex("replied") || stageIndex(lead.status) === -1,
    });
    if (blocker) return blocker;

    try {
      let res;
      if (channel === "email") {
        const unsubscribeUrl = this.unsubscribeUrl(leadId);
        const { text, html } = composeEmail(this.cfg, draft.emailBody, unsubscribeUrl);
        res = await this.deps.email!.send({ to: lead.email!, subject: draft.emailSubject, text, html, unsubscribeUrl, leadId });
        this.crm.recordMessage({
          leadId, draftId: draft.id, channel, direction: "outbound", provider: res.provider, providerId: res.providerId,
          to: lead.email, subject: draft.emailSubject, body: text, status: "sent", error: null,
        });
      } else {
        const body = composeSms(draft.smsBody);
        res = await this.deps.sms!.send({ to: lead.phone!, body, statusCallback: `${this.cfg.publicBaseUrl}/webhooks/twilio/status`, leadId });
        this.crm.recordMessage({
          leadId, draftId: draft.id, channel, direction: "outbound", provider: res.provider, providerId: res.providerId,
          to: lead.phone, subject: null, body, status: "sent", error: null,
        });
      }
      this.crm.logEvent(leadId, `${channel}.sent`, `${res.provider} ${res.providerId ?? ""}`.trim());
      this.crm.setStatus(leadId, "sent");
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.crm.recordMessage({
        leadId, draftId: draft.id, channel, direction: "outbound", provider: sender.name, providerId: null,
        to: channel === "email" ? lead.email : lead.phone, subject: null, body: "", status: "failed", error: msg,
      });
      this.crm.logEvent(leadId, `${channel}.failed`, msg);
      return `send failed: ${msg}`;
    }
  }

  // ---------- 6. CRM tracking: delivery + replies ----------

  /** Provider delivery events (Resend webhooks, Twilio status callbacks). */
  handleDeliveryEvent(provider: string, providerId: string, status: MessageStatus | "complained", error?: string): boolean {
    const msg = this.crm.findMessageByProviderId(provider, providerId);
    if (!msg) return false;
    if (status === "complained") {
      this.crm.optOut(msg.leadId, `spam complaint via ${provider}`);
      return true;
    }
    // Don't let a late "sent" overwrite "delivered".
    const rank: Record<string, number> = { queued: 0, sent: 1, delivered: 2, failed: 3, bounced: 3 };
    if ((rank[status] ?? 0) >= (rank[msg.status] ?? 0)) this.crm.setMessageStatus(msg.id, status, error);
    this.crm.logEvent(msg.leadId, `${msg.channel}.${status}`, error ?? provider);
    if (status === "delivered") this.crm.setStatus(msg.leadId, "delivered");
    if (status === "bounced") {
      const lead = this.mustLead(msg.leadId);
      if (msg.channel === "email" && lead.email) this.crm.suppress(lead.email, "hard bounce");
      // Only mark the lead bounced if no other channel is still in play.
      const others = this.crm.messagesForLead(msg.leadId).filter((m) => m.id !== msg.id && m.direction === "outbound" && ["sent", "delivered"].includes(m.status));
      if (!others.length && stageIndex(lead.status) < stageIndex("replied")) this.crm.setStatus(msg.leadId, "bounced", error);
    }
    return true;
  }

  /** An inbound reply (email or SMS). Classifies intent and advances the pipeline. */
  async handleInbound(
    channel: Channel,
    from: string,
    text: string,
    provider: string,
    providerId: string | null = null,
  ): Promise<{ lead: Lead | null; intent: ReplyClassification["classification"] | null; classification?: ReplyClassification }> {
    const address = channel === "email" ? extractAddress(from) : from;
    const lead = channel === "email" ? this.crm.findLeadByEmail(address) : this.crm.findLeadByPhone(address);
    if (!lead) {
      // Still honour STOP from unknown numbers/addresses.
      if (isOptOut(text)) this.crm.suppress(address, `${channel} opt-out from unknown sender`);
      return { lead: null, intent: null };
    }
    this.crm.recordMessage({
      leadId: lead.id, draftId: null, channel, direction: "inbound", provider, providerId,
      to: null, subject: null, body: text, status: "received", error: null,
    });

    let cls: ReplyClassification;
    if (isOptOut(text)) {
      cls = { classification: "UNSUBSCRIBE", sentiment: "NEGATIVE", recommendedAction: "Opt-out keyword: do not contact again.", shouldPauseSequence: true };
    } else if (this.deps.personalizer) {
      try {
        cls = await this.deps.personalizer.classifyReply(lead, text, channel);
      } catch (err) {
        cls = {
          classification: "OTHER",
          sentiment: "NEUTRAL",
          recommendedAction: `Read and reply manually (classification failed: ${err instanceof Error ? err.message : err})`,
          shouldPauseSequence: true,
        };
      }
    } else {
      cls = { classification: "OTHER", sentiment: "NEUTRAL", recommendedAction: "Read and reply manually.", shouldPauseSequence: true };
    }
    this.applyClassification(lead.id, channel, cls, text);
    return { lead: this.mustLead(lead.id), intent: cls.classification, classification: cls };
  }

  /** Move the lead through the CRM according to a reply classification. */
  applyClassification(leadId: number, channel: Channel, cls: ReplyClassification, text = ""): void {
    this.crm.logEvent(leadId, `${channel}.reply`, `${cls.classification} (${cls.sentiment}): ${cls.recommendedAction}`);
    switch (cls.classification) {
      case "UNSUBSCRIBE":
        this.crm.optOut(leadId, `${channel} reply: ${text.slice(0, 80)}`);
        break;
      case "NOT_INTERESTED":
        this.crm.setStatus(leadId, "replied");
        this.crm.setStatus(leadId, "lost", cls.recommendedAction);
        break;
      case "MEETING_BOOKED":
        this.crm.setStatus(leadId, "replied");
        this.crm.setStatus(leadId, "interested");
        this.crm.setStatus(leadId, "booked", cls.recommendedAction);
        break;
      case "INTERESTED":
        this.crm.setStatus(leadId, "replied");
        this.crm.setStatus(leadId, "interested", cls.recommendedAction);
        break;
      case "OUT_OF_OFFICE":
        if (!cls.shouldPauseSequence) break; // auto-reply: keep the sequence going
        this.crm.setStatus(leadId, "replied", cls.recommendedAction);
        break;
      default: // QUESTION, WRONG_PERSON, OTHER: a human needs to look
        this.crm.setStatus(leadId, "replied", cls.recommendedAction);
    }
  }

  /** Manual pipeline moves from the dashboard (e.g. booked → closed, or lost). */
  markStage(leadId: number, stage: LeadStatus, note?: string): Lead {
    const lead = this.mustLead(leadId);
    if (stage === "opted_out") this.crm.optOut(leadId, note ?? "manual");
    else this.crm.setStatus(leadId, stage, note ?? `manual: ${lead.status} → ${stage}`, { force: true });
    return this.mustLead(leadId);
  }

  // ---------- Lead Details AI actions (generate + save for review; never send) ----------

  private requireClaude(): ClaudeService {
    if (!this.deps.claude) throw new Error("Claude is not configured: set ANTHROPIC_API_KEY on the server.");
    return this.deps.claude;
  }

  /** Run Claude's lead analysis, store it on the lead, and use its score as the lead's fit score. */
  async analyzeLead(leadId: number, overrides: Partial<Pick<AnalyzeLeadInput, "description" | "notes" | "knownWebsiteIssues">> = {}) {
    const lead = this.mustLead(leadId);
    if (overrides.description !== undefined || overrides.notes !== undefined) {
      this.crm.updateLead(leadId, { description: overrides.description, notes: overrides.notes });
    }
    const analysis = await this.requireClaude().analyzeLead(leadToInput(this.mustLead(leadId), overrides));
    this.crm.updateLead(leadId, { analysis: { ...analysis, analyzedAt: this.now().toISOString() }, score: analysis.leadScore });
    this.crm.logEvent(leadId, "ai.analyzed", `${analysis.quality} · lead ${analysis.leadScore} · website ${analysis.websiteScore} · ${analysis.recommendedChannel}`);
    if (lead.status === "new") this.crm.setStatus(leadId, "enriched", "analyzed by Claude");
    return analysis;
  }

  async generateEmail(leadId: number): Promise<ColdEmail> {
    const lead = this.mustLead(leadId);
    const email = await this.requireClaude().generateColdEmail({ lead: leadToInput(lead), analysis: lead.analysis ?? undefined });
    this.saveGenerated(leadId, { emailSubject: email.subject, emailBody: email.body }, "ai.email_generated");
    return email;
  }

  async generateSms(leadId: number): Promise<ColdSms> {
    const lead = this.mustLead(leadId);
    const sms = await this.requireClaude().generateColdSMS({ lead: leadToInput(lead), analysis: lead.analysis ?? undefined });
    this.saveGenerated(leadId, { smsBody: sms.message }, "ai.sms_generated");
    return sms;
  }

  /** Draft a follow-up from the lead's message history. Returned for review only — not saved as the outreach draft, not sent. */
  async generateFollowUp(leadId: number, channel: "EMAIL" | "SMS"): Promise<FollowUp> {
    const lead = this.mustLead(leadId);
    const history = this.crm.messagesForLead(leadId).filter((m) => m.status !== "failed" && m.body);
    const outbound = history.filter((m) => m.direction === "outbound");
    const last = history.at(-1);
    const result = await this.requireClaude().generateFollowUp({
      lead: leadToInput(lead),
      analysis: lead.analysis ?? undefined,
      channel,
      followUpNumber: Math.max(1, outbound.length),
      previousMessages: history.slice(-10).map((m) => ({
        channel: m.channel === "email" ? "EMAIL" : "SMS",
        direction: m.direction === "outbound" ? "OUTBOUND" : "INBOUND",
        subject: m.subject ?? "",
        body: m.body.slice(0, 6000),
        sentAt: m.createdAt,
      })),
      daysSinceLastMessage: last ? Math.floor((this.now().getTime() - new Date(last.createdAt).getTime()) / 86_400_000) : undefined,
    });
    this.crm.logEvent(leadId, "ai.follow_up_generated", channel);
    return result;
  }

  /** Classify a reply pasted in by a human (e.g. one received outside the webhooks) and update the CRM. */
  async classifyLeadReply(leadId: number, replyText: string, channel: Channel = "email"): Promise<ReplyClassification> {
    const lead = this.mustLead(leadId);
    const cls = isOptOut(replyText)
      ? { classification: "UNSUBSCRIBE" as const, sentiment: "NEGATIVE" as const, recommendedAction: "Opt-out keyword: do not contact again.", shouldPauseSequence: true }
      : await this.requireClaude().classifyReply({ replyText, channel: channel === "email" ? "EMAIL" : "SMS", businessName: lead.businessName });
    this.crm.recordMessage({
      leadId, draftId: null, channel, direction: "inbound", provider: "manual", providerId: null,
      to: null, subject: null, body: replyText, status: "received", error: null,
    });
    this.applyClassification(leadId, channel, cls, replyText);
    return cls;
  }

  /**
   * Store generated copy as a NEW, unapproved draft (carrying over the other channel's text),
   * so it can be reviewed and edited. Because sending requires the latest draft to be
   * approved, generating new copy also holds any send that was previously approved.
   */
  private saveGenerated(leadId: number, patch: { emailSubject?: string; emailBody?: string; smsBody?: string }, event: string): void {
    const lead = this.mustLead(leadId);
    const prev = this.crm.latestDraft(leadId);
    const draft = this.crm.saveDraft(leadId, {
      emailSubject: patch.emailSubject ?? prev?.emailSubject ?? "",
      emailBody: patch.emailBody ?? prev?.emailBody ?? "",
      smsBody: patch.smsBody ?? prev?.smsBody ?? "",
      reasoning: lead.analysis?.reasonForContacting ?? prev?.reasoning ?? "",
    });
    this.crm.logEvent(leadId, event, `saved as unapproved draft ${draft.id}`);
    if (["new", "enriched"].includes(lead.status)) this.crm.setStatus(leadId, "drafted");
    else if (lead.status === "approved") this.crm.setStatus(leadId, "pending_approval", "new AI copy needs review", { force: true });
  }

  // ---------- unsubscribe links ----------

  unsubscribeToken(leadId: number): string {
    return createHmac("sha256", this.cfg.appSecret).update(`unsub:${leadId}`).digest("base64url").slice(0, 32);
  }

  unsubscribeUrl(leadId: number): string {
    return `${this.cfg.publicBaseUrl}/unsubscribe/${leadId}/${this.unsubscribeToken(leadId)}`;
  }

  unsubscribe(leadId: number, token: string): boolean {
    const expected = Buffer.from(this.unsubscribeToken(leadId));
    const got = Buffer.from(token);
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return false;
    if (!this.crm.getLead(leadId)) return false;
    this.crm.optOut(leadId, "unsubscribe link");
    return true;
  }

  // ---------- full run ----------

  /** Run every stage for leads that are ready for it. */
  async runAll(opts: { query?: SearchQuery; send?: boolean } = {}): Promise<Record<string, unknown>> {
    const summary: Record<string, unknown> = {};
    if (opts.query) {
      const r = await this.findLeads(opts.query);
      summary.found = r.found;
      summary.newLeads = r.created.length;
    }
    let enriched = 0;
    for (const l of this.crm.listLeads({ status: "new", limit: 10_000 })) {
      await this.enrich(l.id).catch((e) => this.crm.logEvent(l.id, "enrich.failed", String(e)));
      enriched++;
    }
    summary.enriched = enriched;
    if (this.deps.personalizer) {
      const decisions: Record<string, number> = {};
      for (const l of this.crm.listLeads({ status: "enriched", limit: 10_000 })) {
        try {
          const { decision } = await this.draft(l.id);
          decisions[decision.action] = (decisions[decision.action] ?? 0) + 1;
        } catch (e) {
          this.crm.logEvent(l.id, "draft.failed", String(e));
          decisions.failed = (decisions.failed ?? 0) + 1;
        }
      }
      summary.drafts = decisions;
    }
    if (opts.send !== false) {
      const r = await this.sendDue();
      summary.sent = r.sent.length;
      summary.held = r.held.length;
    }
    return summary;
  }

  private mustLead(id: number): Lead {
    const l = this.crm.getLead(id);
    if (!l) throw new Error(`lead ${id} not found`);
    return l;
  }
}

export function extractAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim().toLowerCase();
}
