import { Router, type IRouter } from "express";
import healthRouter from "./health";
import botRouter from "./bot";
import configRouter from "./config";
import creatorsRouter from "./creators";
import tradesRouter from "./trades";
import dashboardRouter from "./dashboard";
import manualRouter from "./manual";

const router: IRouter = Router();

router.use(healthRouter);
router.use(botRouter);
router.use(configRouter);
router.use(creatorsRouter);
router.use(tradesRouter);
router.use(dashboardRouter);
router.use(manualRouter);

export default router;
