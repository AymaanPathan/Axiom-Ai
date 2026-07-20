// src/routes/observability.routes.ts
import { Router } from "express";
import { getRouteStats, hasRecentTraffic } from "../services/signoz.service.js";

const router = Router();

router.get("/:repositoryId/status", async (req, res) => {
  const serviceName = req.query.serviceName as string;
  if (!serviceName)
    return res
      .status(400)
      .json({ success: false, message: "serviceName required" });
  try {
    const live = await hasRecentTraffic(serviceName);
    res.json({ success: true, status: live ? "live" : "waiting" });
  } catch (err) {
    console.error("SigNoz status check failed", err);
    res.status(502).json({ success: false, message: "Could not reach SigNoz" });
  }
});

router.get("/:repositoryId/metrics", async (req, res) => {
  const serviceName = req.query.serviceName as string;
  if (!serviceName)
    return res
      .status(400)
      .json({ success: false, message: "serviceName required" });
  try {
    res.json({ success: true, routes: await getRouteStats(serviceName) });
  } catch (err) {
    console.error("SigNoz metrics fetch failed", err);
    res.status(502).json({ success: false, message: "Could not reach SigNoz" });
  }
});

export default router;
