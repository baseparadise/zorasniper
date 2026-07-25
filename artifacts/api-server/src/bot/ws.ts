import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { logger } from "../lib/logger";

let wss: WebSocketServer | null = null;

export function startWsServer(server: Server): void {
  wss = new WebSocketServer({ server, path: "/api/ws" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
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
