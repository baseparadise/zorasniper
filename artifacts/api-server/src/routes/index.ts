import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { publicAuthRouter, protectedAuthRouter } from "./auth";
import botRouter from "./bot";
import configRouter from "./config";
import creatorsRouter from "./creators";
import tradesRouter from "./trades";
import dashboardRouter from "./dashboard";
import manualRouter from "./manual";

// Public: no auth required (healthz + login + logout only)
export const publicRouter: IRouter = Router();
publicRouter.use(healthRouter);
publicRouter.use(publicAuthRouter);

// Protected: requires valid session cookie (authMiddleware applied in app.ts)
export const protectedRouter: IRouter = Router();
protectedRouter.use(protectedAuthRouter); // GET /auth/check
protectedRouter.use(botRouter);
protectedRouter.use(configRouter);
protectedRouter.use(creatorsRouter);
protectedRouter.use(tradesRouter);
protectedRouter.use(dashboardRouter);
protectedRouter.use(manualRouter);

export default protectedRouter;
