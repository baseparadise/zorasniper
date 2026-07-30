import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { join } from "path";
import { existsSync } from "fs";
import { publicRouter, protectedRouter } from "./routes";
import { authMiddleware } from "./middlewares/auth";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Restrict CORS to the configured origin (or reflect the request origin in dev).
// Set ALLOWED_ORIGIN in production to the exact frontend domain.
// credentials:true is required so the session cookie is sent cross-origin (e.g. dev).
const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(
  cors({
    credentials: true,
    origin: allowedOrigin || ((origin, cb) => cb(null, origin ?? false)),
  }),
);

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Public routes — healthz + auth/login + auth/logout (no session required)
app.use("/api", publicRouter);

// Auth gate — everything below this requires a valid session cookie
app.use("/api", authMiddleware);

// Protected routes
app.use("/api", protectedRouter);

// Serve frontend static files — check built Vite dist first, then static public folder
const frontendDist = join(process.cwd(), "artifacts/zora-sniper/dist/public");
const staticPublic = join(process.cwd(), "artifacts/api-server/public");
const staticRoot = existsSync(frontendDist)
  ? frontendDist
  : existsSync(staticPublic)
    ? staticPublic
    : null;

if (staticRoot) {
  app.use(express.static(staticRoot));
  // Fallback to index.html for client-side routing
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(join(staticRoot, "index.html"));
  });
  logger.info({ staticRoot }, "Serving frontend static files");
} else {
  logger.warn({ frontendDist, staticPublic }, "No frontend found — skipping static file serving");
}

// JSON error handler — returns actual error details instead of blank HTML page.
// Must be defined after all routes and static middleware.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Unhandled request error");
  res.status(500).json({
    error: err.message ?? "Internal Server Error",
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
});

export default app;
