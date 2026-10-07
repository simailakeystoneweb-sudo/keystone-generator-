import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Config } from "../config.js";

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Bearer DASHBOARD_TOKEN on every /api route. With no token set the API is open (local use only). */
export function requireToken(cfg: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!cfg.dashboardToken) return next();
    const header = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (header && safeEqual(header, cfg.dashboardToken)) return next();
    res.status(401).json({ error: "unauthorized" });
  };
}

/**
 * With no DASHBOARD_TOKEN the API has no auth, so only allow sensitive calls (AI, sending) from this
 * machine. Uses the socket address, which can't be spoofed with X-Forwarded-For.
 */
export function localOnlyWithoutToken(cfg: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (cfg.dashboardToken) return next();
    const ip = req.socket.remoteAddress ?? "";
    if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return next();
    res.status(403).json({ error: "Set DASHBOARD_TOKEN to use this endpoint from another machine." });
  };
}

/** Fixed-window per-client limit so a leaked token or a stuck button can't run up the Claude bill or spam leads. */
export function rateLimit(perMinute: number, what = "requests") {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    if (perMinute <= 0) return next();
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.windowStart >= 60_000) {
      hits.set(key, { windowStart: now, count: 1 });
      if (hits.size > 10_000) hits.clear();
      return next();
    }
    if (++h.count > perMinute) {
      res.setHeader("Retry-After", String(Math.ceil((h.windowStart + 60_000 - now) / 1000)));
      return void res.status(429).json({ error: `Too many ${what}; slow down.` });
    }
    next();
  };
}
