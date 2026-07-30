import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { logger } from "../lib/logger";
import { COOKIE_NAME, validateSession } from "../middlewares/auth";

let wss: WebSocketServer | null = null;

/** Parse a raw Cookie header string into a key→value map. */
function parseCookies(cookieHeader: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = val;
  }
  return out;
}

export function startWsServer(server: Server): void {
  wss = new WebSocketServer({ server, path: "/api/ws" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // ── Auth check — reject unauthenticated WebSocket connections ──────────
    const cookies = parseCookies(req.headers.cookie ?? "");
    const token = cookies[COOKIE_NAME];

    if (!validateSession(token)) {
      logger.warn({ ip: req.socket.remoteAddress }, "WS connection rejected — unauthorized");
      ws.close(1008, "Unauthorized");
      return;
    }

    logger.info({ ip: req.socket.remoteAddress }, "WS client connected");

    ws.on("close", () => {
      logger.info({ ip: req.socket.remoteAddress }, "WS client disconnected");
    });

    ws.on("error", (err) => {
      logger.error({ err }, "WS client error");
    });

    // Send welcome ping
    safeSend(ws, { type: "connected", payload: { message: "Zora Sniper connected" } });
  });

  logger.info("WebSocket server started at /api/ws");
}

function safeSend(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

export function broadcast(type: string, payload: unknown): void {
  if (!wss) return;
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}
