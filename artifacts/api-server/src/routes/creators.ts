import { Router, type IRouter } from "express";
import { db, creatorsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  ListCreatorsResponse,
  AddCreatorBody,
  AddCreatorResponse,
  RemoveCreatorParams,
  UpdateCreatorParams,
  UpdateCreatorBody,
  UpdateCreatorResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/creators", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(creatorsTable)
    .orderBy(creatorsTable.addedAt);
  res.json(ListCreatorsResponse.parse(rows));
});

router.post("/creators", async (req, res): Promise<void> => {
  const parsed = AddCreatorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const address = parsed.data.address.toLowerCase();

  const existing = await db
    .select()
    .from(creatorsTable)
    .where(eq(creatorsTable.address, address))
    .limit(1);

  if (existing.length > 0) {
    res.status(400).json({ error: "Creator already in whitelist" });
    return;
  }

  const [creator] = await db
    .insert(creatorsTable)
    .values({
      address,
      label: parsed.data.label ?? "",
      enabled: true,
    })
    .returning();

  res.status(201).json(AddCreatorResponse.parse(creator));
});

router.delete("/creators/:address", async (req, res): Promise<void> => {
  const params = RemoveCreatorParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const address = params.data.address.toLowerCase();
  const deleted = await db
    .delete(creatorsTable)
    .where(eq(creatorsTable.address, address))
    .returning();

  if (deleted.length === 0) {
    res.status(404).json({ error: "Creator not found" });
    return;
  }

  res.status(204).send();
});

router.patch("/creators/:address", async (req, res): Promise<void> => {
  const params = UpdateCreatorParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const bodyParsed = UpdateCreatorBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: bodyParsed.error.message });
    return;
  }

  const address = params.data.address.toLowerCase();
  const body = bodyParsed.data;

  // Build update object — numeric overrides stored as TEXT, integers stored as INTEGER
  const updateData: Partial<typeof creatorsTable.$inferInsert> = {};

  if (body.label !== undefined) updateData.label = body.label;
  if (body.enabled !== undefined) updateData.enabled = body.enabled;

  if ("buyAmountEth" in body) updateData.buyAmountEth = body.buyAmountEth ?? null;
  if ("slippagePercent" in body) {
    updateData.slippagePercent =
      body.slippagePercent != null ? String(body.slippagePercent) : null;
  }
  if ("maxGasGwei" in body) {
    updateData.maxGasGwei =
      body.maxGasGwei != null ? String(body.maxGasGwei) : null;
  }
  if ("autoSell" in body) updateData.autoSell = body.autoSell ?? null;
  if ("takeProfitPercent" in body) {
    updateData.takeProfitPercent =
      body.takeProfitPercent != null ? String(body.takeProfitPercent) : null;
  }
  if ("stopLossPercent" in body) {
    updateData.stopLossPercent =
      body.stopLossPercent != null ? String(body.stopLossPercent) : null;
  }
  if ("maxBuysPerDay" in body) updateData.maxBuysPerDay = body.maxBuysPerDay ?? null;

  if (Object.keys(updateData).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const [updated] = await db
    .update(creatorsTable)
    .set(updateData)
    .where(eq(creatorsTable.address, address))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Creator not found" });
    return;
  }

  res.json(UpdateCreatorResponse.parse(updated));
});

export default router;
