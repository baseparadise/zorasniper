import { randomBytes } from "crypto";
import { type Request, type Response, type NextFunction } from "express";

export const COOKIE_NAME = "zs_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// In-memory session store: token → expiry timestamp
const sessions = new Map<string, number>();

export function createSession(): string {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;
  const expiry = token ? sessions.get(token) : undefined;

  if (expiry && expiry > Date.now()) {
    return next();
  }

  res.status(401).json({ error: "Unauthorized" });
}
