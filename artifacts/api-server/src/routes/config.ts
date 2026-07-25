import { Router, type IRouter } from "express";
import { loadConfig, saveConfig } from "../lib/config";
import { GetConfigResponse, UpdateConfigBody, UpdateConfigResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/config", async (_req, res): Promise<void> => {
  const config = await loadConfig();
  res.json(GetConfigResponse.parse(config));
});

router.put("/config", async (req, res): Promise<void> => {
  const parsed = UpdateConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updated = await saveConfig(parsed.data as Parameters<typeof saveConfig>[0]);
  res.json(UpdateConfigResponse.parse(updated));
});

export default router;
