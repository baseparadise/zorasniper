import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { join } from "path";
import { existsSync } from "fs";
import router from "./routes";
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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Serve frontend static files in production
if (process.env.NODE_ENV === "production") {
  const frontendDist = join(process.cwd(), "artifacts/zora-sniper/dist/public");
  if (existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    // Fallback to index.html for client-side routing
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(join(frontendDist, "index.html"));
    });
    logger.info({ frontendDist }, "Serving frontend static files");
  }
}

export default app;
