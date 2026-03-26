import { Router, type IRouter } from "express";
import healthRouter from "./health";
import botRouter from "./bot";
import controlRouter from "./control";

const router: IRouter = Router();

router.use(healthRouter);
router.use(controlRouter);
router.use(botRouter);

export default router;
