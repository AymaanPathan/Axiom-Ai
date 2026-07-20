import { createClient } from "redis";

export const redis = createClient({
  url: process.env.REDIS_URL,
});

export async function connectRedis() {
  try {
    await redis.connect();
    console.log("✅ Redis Connected");
  } catch (error) {
    console.error("❌ Redis Connection Failed:", error);
    process.exit(1);
  }
}
