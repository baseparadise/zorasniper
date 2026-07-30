import { Router } from "express";
import {
  COOKIE_NAME,
  createSession,
  destroySession,
  safeStringEqual,
} from "../middlewares/auth";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── Public router (no session required) ──────────────────────────────────────

export const publicAuthRouter = Router();

// POST /api/auth/login
publicAuthRouter.post("/auth/login", (req, res) => {
  const { password } = req.body as { password?: string };
  const expected = process.env.WEB_PASSWORD;

  if (!expected) {
    res.status(503).json({ error: "WEB_PASSWORD is not configured on the server" });
    return;
  }

  // Use constant-time comparison to prevent timing-based password enumeration.
  if (!password || !safeStringEqual(password, expected)) {
    res.status(401).json({ error: "Wrong password" });
    return;
  }

  const token = createSession();
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    secure: process.env.NODE_ENV === "production",
  });
  res.json({ ok: true });
});

// POST /api/auth/logout
publicAuthRouter.post("/auth/logout", (req, res) => {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;
  if (token) destroySession(token);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// ── Protected router (requires valid session) ─────────────────────────────────

export const protectedAuthRouter = Router();

// GET /api/auth/check — authMiddleware runs before this in app.ts
protectedAuthRouter.get("/auth/check", (_req, res) => {
  res.json({ ok: true });
});
