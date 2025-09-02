// src/services/queue.js - QUEUE SERVICE (singleton)
import Queue from "bull";
import Redis from "ioredis";

// Redis connection configuration (unchanged behavior)
const redisConfig = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  db: Number(process.env.REDIS_DB || 0),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  // lazyConnect: true,
};

console.log("🔴 Redis Configuration:", {
  host: redisConfig.host,
  port: redisConfig.port,
  db: redisConfig.db,
  hasPassword: !!redisConfig.password,
});

// Create Redis instance (shared)
export const redis = new Redis(redisConfig);

// Create parse queue (shared)
export const parseQueue = new Queue(process.env.QUEUE_NAME || "parse_jobs", {
  prefix: process.env.QUEUE_PREFIX || 'bull',
  redis: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 5,
    attempts: parseInt(process.env.MAX_JOB_ATTEMPTS || "2"),
    backoff: {
      type: "exponential",
      delay: parseInt(process.env.BACKOFF_DELAY_MS || "5000"),
    },
  },
});

// Queue event handlers (kept)
parseQueue.on("error", (error) => {
  console.error("❌ Queue error:", error);
});

parseQueue.on("ready", () => {
  console.log("✅ Queue is ready");
});

parseQueue.on("waiting", (jobId) => {
  console.log(`⏳ Job waiting: ${jobId}`);
});

// Redis connection events (kept)
redis.on("connect", () => {
  console.log("✅ Redis connected");
});

redis.on("error", (error) => {
  console.error("❌ Redis error:", error);
});

// Helper to close both cleanly (new, needed for graceful shutdowns)
export async function closeQueue() {
  try {
    await parseQueue.close();
  } catch (_) {}
  try {
    await redis.disconnect();
  } catch (_) {}
}

export default parseQueue;
