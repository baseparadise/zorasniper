import { randomBytes, timingSafeEqual } from "crypto";
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

/**
 * Validate a session token without exposing the sessions Map.
 * Used by the WebSocket server for upgrade-request auth.
 */
export function validateSession(token: string | undefined): boolean {
  if (!token) return false;
  const expiry = sessions.get(token);
  return !!(expiry && expiry > Date.now());
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns true only when both strings are identical in length and content.
 */
export function safeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Run a dummy comparison to normalise timing regardless of length difference.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;

  if (validateSession(token)) {
    return next();
  }

  res.status(401).json({ error: "Unauthorized" });
}
