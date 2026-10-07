import { DatabaseSync } from "node:sqlite";
import type {
  Channel,
  Draft,
  Lead,
  LeadStatus,
  MessageStatus,
  OutboundMessage,
  RawBusiness,
  WebsiteAudit,
} from "../types.js";
import { PIPELINE } from "../types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  industry TEXT,
  city TEXT,
  address TEXT,
  source TEXT NOT NULL,
  source_id TEXT,
  rating REAL,
  review_count INTEGER,
  audit_json TEXT,
  score INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  sms_consent INTEGER NOT NULL DEFAULT 0,
  opted_out INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS leads_source_uq ON leads(source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads(status);
CREATE INDEX IF NOT EXISTS leads_email_idx ON leads(lower(email));
CREATE INDEX IF NOT EXISTS leads_phone_idx ON leads(phone);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  email_subject TEXT NOT NULL,
  email_body TEXT NOT NULL,
  sms_body TEXT NOT NULL,
  reasoning TEXT NOT NULL DEFAULT '',
  approved INTEGER NOT NULL DEFAULT 0,
  decision TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  draft_id INTEGER REFERENCES drafts(id),
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_id TEXT,
  recipient TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS messages_provider_idx ON messages(provider, provider_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS events_lead_idx ON events(lead_id);

CREATE TABLE IF NOT EXISTS suppressions (
  value TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

type Row = Record<string, unknown>;

function rowToLead(r: Row): Lead {
  return {
    id: Number(r.id),
    businessName: String(r.business_name),
    contactName: (r.contact_name as string) ?? null,
    email: (r.email as string) ?? null,
    phone: (r.phone as string) ?? null,
    website: (r.website as string) ?? null,
    industry: (r.industry as string) ?? null,
    city: (r.city as string) ?? null,
    address: (r.address as string) ?? null,
    source: String(r.source),
    sourceId: (r.source_id as string) ?? null,
    rating: r.rating == null ? null : Number(r.rating),
    reviewCount: r.review_count == null ? null : Number(r.review_count),
    audit: r.audit_json ? (JSON.parse(String(r.audit_json)) as WebsiteAudit) : null,
    score: r.score == null ? null : Number(r.score),
    status: r.status as LeadStatus,
    smsConsent: Boolean(r.sms_consent),
    optedOut: Boolean(r.opted_out),
    notes: (r.notes as string) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function rowToDraft(r: Row): Draft {
  return {
    id: Number(r.id),
    leadId: Number(r.lead_id),
    emailSubject: String(r.email_subject),
    emailBody: String(r.email_body),
    smsBody: String(r.sms_body),
    reasoning: String(r.reasoning ?? ""),
    approved: Boolean(r.approved),
    decision: (r.decision as string) ?? null,
    createdAt: String(r.created_at),
  };
}

function rowToMessage(r: Row): OutboundMessage {
  return {
    id: Number(r.id),
    leadId: Number(r.lead_id),
    draftId: r.draft_id == null ? null : Number(r.draft_id),
    channel: r.channel as Channel,
    direction: r.direction as "outbound" | "inbound",
    provider: String(r.provider),
    providerId: (r.provider_id as string) ?? null,
    to: (r.recipient as string) ?? null,
    subject: (r.subject as string) ?? null,
    body: String(r.body),
    status: r.status as MessageStatus,
    error: (r.error as string) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits.length >= 9 ? digits : null;
  const d = digits.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`; // assume North America for bare 10-digit numbers
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.length >= 9 ? `+${d}` : null;
}

/**
 * Whether moving a lead from `from` to `to` is allowed. Pipeline stages only
 * advance (a late "delivered" webhook must not undo a "replied"); side stages
 * are always reachable; nothing leaves opted_out except a manual override.
 */
export function canTransition(from: LeadStatus, to: LeadStatus): boolean {
  if (from === to) return false;
  if (from === "opted_out") return false;
  const fi = PIPELINE.indexOf(from as (typeof PIPELINE)[number]);
  const ti = PIPELINE.indexOf(to as (typeof PIPELINE)[number]);
  if (ti === -1) return true; // side stage
  if (fi === -1) return false; // leaving a side stage requires force
  return ti > fi;
}

export class CRM {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------- leads ----------

  /** Insert a business, or return the existing lead if we've seen it (same source id, website or phone). */
  upsertBusiness(b: RawBusiness): { lead: Lead; created: boolean } {
    const phone = normalizePhone(b.phone);
    const website = b.website ? b.website.trim() : null;
    const existing = this.findDuplicate(b.source, b.sourceId ?? null, website, phone);
    if (existing) return { lead: existing, created: false };
    const res = this.db
      .prepare(
        `INSERT INTO leads (business_name, phone, website, industry, city, address, source, source_id, rating, review_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b.businessName,
        phone,
        website,
        b.industry ?? null,
        b.city ?? null,
        b.address ?? null,
        b.source,
        b.sourceId ?? null,
        b.rating ?? null,
        b.reviewCount ?? null,
      );
    const lead = this.getLead(Number(res.lastInsertRowid))!;
    this.logEvent(lead.id, "lead.created", `from ${b.source}`);
    return { lead, created: true };
  }

  private findDuplicate(source: string, sourceId: string | null, website: string | null, phone: string | null): Lead | null {
    if (sourceId) {
      const r = this.db.prepare("SELECT * FROM leads WHERE source = ? AND source_id = ?").get(source, sourceId) as Row | undefined;
      if (r) return rowToLead(r);
    }
    const host = website ? hostOf(website) : null;
    if (host) {
      const rows = this.db.prepare("SELECT * FROM leads WHERE website IS NOT NULL").all() as Row[];
      const hit = rows.find((r) => hostOf(String(r.website)) === host);
      if (hit) return rowToLead(hit);
    }
    if (phone) {
      const r = this.db.prepare("SELECT * FROM leads WHERE phone = ?").get(phone) as Row | undefined;
      if (r) return rowToLead(r);
    }
    return null;
  }

  getLead(id: number): Lead | null {
    const r = this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToLead(r) : null;
  }

  listLeads(filter: { status?: LeadStatus | LeadStatus[]; limit?: number } = {}): Lead[] {
    const statuses = filter.status ? (Array.isArray(filter.status) ? filter.status : [filter.status]) : null;
    const where = statuses ? `WHERE status IN (${statuses.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM leads ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...(statuses ?? []), filter.limit ?? 500) as Row[];
    return rows.map(rowToLead);
  }

  findLeadByEmail(email: string): Lead | null {
    const r = this.db.prepare("SELECT * FROM leads WHERE lower(email) = lower(?) ORDER BY id DESC").get(email.trim()) as Row | undefined;
    return r ? rowToLead(r) : null;
  }

  findLeadByPhone(phone: string): Lead | null {
    const p = normalizePhone(phone);
    if (!p) return null;
    const r = this.db.prepare("SELECT * FROM leads WHERE phone = ? ORDER BY id DESC").get(p) as Row | undefined;
    return r ? rowToLead(r) : null;
  }

  updateLead(
    id: number,
    patch: Partial<Pick<Lead, "contactName" | "email" | "phone" | "website" | "industry" | "city" | "audit" | "score" | "smsConsent" | "notes">>,
  ): Lead {
    const cols: string[] = [];
    const vals: (string | number | null)[] = [];
    const map: Record<string, string> = {
      contactName: "contact_name",
      email: "email",
      phone: "phone",
      website: "website",
      industry: "industry",
      city: "city",
      score: "score",
      notes: "notes",
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (k === "audit") {
        cols.push("audit_json = ?");
        vals.push(v == null ? null : JSON.stringify(v));
      } else if (k === "smsConsent") {
        cols.push("sms_consent = ?");
        vals.push(v ? 1 : 0);
      } else if (k === "phone") {
        cols.push("phone = ?");
        vals.push(normalizePhone(v as string));
      } else if (map[k]) {
        cols.push(`${map[k]} = ?`);
        vals.push(v as string | number | null);
      }
    }
    if (cols.length) {
      cols.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      this.db.prepare(`UPDATE leads SET ${cols.join(", ")} WHERE id = ?`).run(...vals, id);
    }
    return this.getLead(id)!;
  }

  /** Move a lead through the pipeline. Returns false (and does nothing) if the move would go backwards. */
  setStatus(id: number, to: LeadStatus, detail?: string, opts: { force?: boolean } = {}): boolean {
    const lead = this.getLead(id);
    if (!lead) throw new Error(`lead ${id} not found`);
    if (!opts.force && !canTransition(lead.status, to)) return false;
    this.db
      .prepare("UPDATE leads SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(to, id);
    this.logEvent(id, `status.${to}`, detail ?? `${lead.status} → ${to}`);
    return true;
  }

  optOut(id: number, reason: string): void {
    const lead = this.getLead(id);
    if (!lead) return;
    this.db
      .prepare("UPDATE leads SET opted_out = 1, sms_consent = 0, status = 'opted_out', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(id);
    if (lead.email) this.suppress(lead.email, reason);
    if (lead.phone) this.suppress(lead.phone, reason);
    this.logEvent(id, "status.opted_out", reason);
  }

  // ---------- suppression list ----------

  suppress(value: string, reason: string): void {
    const v = suppressionKey(value);
    if (!v) return;
    this.db.prepare("INSERT OR IGNORE INTO suppressions (value, reason) VALUES (?, ?)").run(v, reason);
  }

  isSuppressed(value: string | null | undefined): boolean {
    const v = suppressionKey(value);
    if (!v) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM suppressions WHERE value = ?").get(v));
  }

  // ---------- drafts ----------

  saveDraft(leadId: number, d: { emailSubject: string; emailBody: string; smsBody: string; reasoning: string }): Draft {
    const res = this.db
      .prepare("INSERT INTO drafts (lead_id, email_subject, email_body, sms_body, reasoning) VALUES (?, ?, ?, ?, ?)")
      .run(leadId, d.emailSubject, d.emailBody, d.smsBody, d.reasoning);
    this.logEvent(leadId, "draft.created", `draft ${res.lastInsertRowid}`);
    return this.getDraft(Number(res.lastInsertRowid))!;
  }

  getDraft(id: number): Draft | null {
    const r = this.db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToDraft(r) : null;
  }

  latestDraft(leadId: number): Draft | null {
    const r = this.db.prepare("SELECT * FROM drafts WHERE lead_id = ? ORDER BY id DESC LIMIT 1").get(leadId) as Row | undefined;
    return r ? rowToDraft(r) : null;
  }

  updateDraft(id: number, patch: Partial<Pick<Draft, "emailSubject" | "emailBody" | "smsBody">>): Draft {
    const d = this.getDraft(id);
    if (!d) throw new Error(`draft ${id} not found`);
    this.db
      .prepare("UPDATE drafts SET email_subject = ?, email_body = ?, sms_body = ? WHERE id = ?")
      .run(patch.emailSubject ?? d.emailSubject, patch.emailBody ?? d.emailBody, patch.smsBody ?? d.smsBody, id);
    return this.getDraft(id)!;
  }

  decideDraft(id: number, approved: boolean, decision: string): void {
    this.db.prepare("UPDATE drafts SET approved = ?, decision = ? WHERE id = ?").run(approved ? 1 : 0, decision, id);
  }

  // ---------- messages ----------

  recordMessage(m: Omit<OutboundMessage, "id" | "createdAt" | "updatedAt">): OutboundMessage {
    const res = this.db
      .prepare(
        `INSERT INTO messages (lead_id, draft_id, channel, direction, provider, provider_id, recipient, subject, body, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.leadId, m.draftId, m.channel, m.direction, m.provider, m.providerId, m.to, m.subject, m.body, m.status, m.error);
    return this.getMessage(Number(res.lastInsertRowid))!;
  }

  getMessage(id: number): OutboundMessage | null {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToMessage(r) : null;
  }

  findMessageByProviderId(provider: string, providerId: string): OutboundMessage | null {
    const r = this.db.prepare("SELECT * FROM messages WHERE provider = ? AND provider_id = ?").get(provider, providerId) as Row | undefined;
    return r ? rowToMessage(r) : null;
  }

  setMessageStatus(id: number, status: MessageStatus, error?: string | null): void {
    this.db
      .prepare("UPDATE messages SET status = ?, error = COALESCE(?, error), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(status, error ?? null, id);
  }

  messagesForLead(leadId: number): OutboundMessage[] {
    return (this.db.prepare("SELECT * FROM messages WHERE lead_id = ? ORDER BY id").all(leadId) as Row[]).map(rowToMessage);
  }

  /** Outbound messages on `channel` created since `sinceIso` (used for daily caps). */
  countOutboundSince(channel: Channel, sinceIso: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE channel = ? AND direction = 'outbound' AND status != 'failed' AND created_at >= ?")
      .get(channel, sinceIso) as Row;
    return Number(r.n);
  }

  // ---------- events / reporting ----------

  logEvent(leadId: number | null, type: string, detail?: string): void {
    this.db.prepare("INSERT INTO events (lead_id, type, detail) VALUES (?, ?, ?)").run(leadId, type, detail ?? null);
  }

  eventsForLead(leadId: number): { type: string; detail: string | null; createdAt: string }[] {
    return (this.db.prepare("SELECT type, detail, created_at FROM events WHERE lead_id = ? ORDER BY id").all(leadId) as Row[]).map((r) => ({
      type: String(r.type),
      detail: (r.detail as string) ?? null,
      createdAt: String(r.created_at),
    }));
  }

  /** Lead counts per status, plus funnel counts ("reached at least stage X"). */
  stats(): { byStatus: Record<string, number>; funnel: Record<string, number> } {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all() as Row[];
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[String(r.status)] = Number(r.n);
    const reached = this.db
      .prepare("SELECT type, COUNT(DISTINCT lead_id) AS n FROM events WHERE type LIKE 'status.%' GROUP BY type")
      .all() as Row[];
    const funnel: Record<string, number> = {};
    for (const stage of ["sent", "delivered", "replied", "interested", "booked", "closed"]) funnel[stage] = 0;
    for (const r of reached) {
      const stage = String(r.type).slice("status.".length);
      if (stage in funnel) funnel[stage] = Number(r.n);
    }
    return { byStatus, funnel };
  }
}

export function hostOf(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function suppressionKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v.includes("@")) return v;
  return normalizePhone(v);
}
