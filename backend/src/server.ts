import "dotenv/config";
import "./config/telemetry.js";
import http from "node:http";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import { connectRedis } from "./config/redis.js";
import { initSocket } from "./config/socket.js";
import authRoutes from "./routes/auth.routes.js";
import reposRoutes from "./routes/repos.routes.js";
import { buildRunnerImage } from "./docker/docker-run.service.js"; // NEW

const app = express();
const httpServer = http.createServer(app);
initSocket(httpServer);

await connectRedis();

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

app.get("/", (_, res) => {
  res.json({ message: "Backend running 🚀" });
});

app.get("/health", (_, res) => {
  res.json({ success: true });
});

app.use("/auth", authRoutes);
app.use("/repos", reposRoutes);

const PORT = process.env.PORT || 5000;

await mongoose.connect(process.env.MONGO_URI!);
console.log("✅ MongoDB Connected");

// Build the axiom-runner image (node:20-alpine + OTel bootstrap) once at
// boot. Non-fatal if it fails — existing runs would just fall back to
// whatever image was last built; log loudly so it's not silently missed.
buildRunnerImage().catch((err) => {
  console.error("⚠️  Failed to build axiom-runner image:", err);
});

httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
