// src/server.js - Phase 1: add preflight gate before queue add
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import multer from "multer";
import path from "path";
import fs from "fs-extra";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createLogger, format, transports } from "winston";

import { authenticateRequest } from "./middleware/auth.js";
import { rateLimitMiddleware } from "./middleware/limit.js";
import parseQueue, { redis, closeQueue } from "./services/queue.js";
import {
  runPreflight,
  writePreflight,
  writeLayers,
  writePlates,
} from "./services/preflight.js";

dotenv.config();

// __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8000;

// Logger
const logDir = process.env.LOG_DIR || "/var/log/parser";
await fs.ensureDir(logDir);
const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: "parser-api" },
  transports: [
    new transports.File({
      filename: path.join(logDir, "error.log"),
      level: "error",
    }),
    new transports.File({ filename: path.join(logDir, "combined.log") }),
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    }),
  ],
});

// Upload dir
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "./uploads");
await fs.ensureDir(UPLOAD_DIR);

// Initialize queue (never start paused)
await initializeQueue();
async function initializeQueue() {
  await parseQueue.isReady();
  await parseQueue.resume();
  // clean known paused keys (defensive)
  await redis.del("bull:parse_jobs:paused");
  await redis.del("bull:parse_jobs:meta-paused");
}

// Security & baseline middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (
        process.env.NODE_ENV === "development" &&
        origin.includes("localhost")
      )
        return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
    optionsSuccessStatus: 200,
  })
);
app.use(compression());
app.use(
  morgan("combined", {
    stream: { write: (msg) => logger.info(msg.trim()) },
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(rateLimitMiddleware);
app.set("trust proxy", 1);

// Upload config
const upload = multer({
  dest: "/tmp/",
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || "104857600", 10), // 100MB
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const validTypes = [".ai", ".pdf"];
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = validTypes.includes(ext) || file.mimetype === "application/pdf";
    if (!ok) {
      const error = new Error(
        "Invalid file type. Only .ai and .pdf files are allowed."
      );
      error.code = "INVALID_FILE_TYPE";
      return cb(error, false);
    }
    if (file.mimetype === "application/pdf" && ext !== ".pdf") {
      const error = new Error("File extension does not match MIME type.");
      error.code = "MIME_MISMATCH";
      return cb(error, false);
    }
    cb(null, true);
  },
});

// ===== Routes =====

// Submit parse job with Phase-1 preflight
app.post(
  "/jobs",
  authenticateRequest,
  upload.single("file"),
  async (req, res) => {
    let jobId, jobDir;
    try {
      jobId = req.query.jobId || uuidv4();
      const file = req.file;
      const options = (() => {
        try {
          return JSON.parse(req.body.options || "{}");
        } catch {
          return {};
        }
      })();

      if (!file) {
        return res
          .status(400)
          .json({ error: "No file uploaded", code: "NO_FILE" });
      }

      const tmpStats = await fs.stat(file.path);
      if (!tmpStats.isFile()) {
        await fs.remove(file.path);
        return res
          .status(400)
          .json({ error: "Invalid file upload", code: "INVALID_FILE" });
      }

      jobDir = path.join(UPLOAD_DIR, jobId);
      await fs.ensureDir(jobDir);
      await fs.ensureDir(path.join(jobDir, "assets"));

      const finalPath = path.join(jobDir, file.originalname);
      await fs.move(file.path, finalPath, { overwrite: true });

      // ---- Phase 1: Preflight (metadata-only) ----
      const preflight = await runPreflight(finalPath);
      await writePreflight(jobDir, preflight);

      await writeLayers(jobDir, preflight?.detected?.ocgNames || []);
      await writePlates(
        jobDir,
        preflight?.detected?.separations || [],
        preflight?.detected?.separationMap || {}
      );

      if (!preflight.pass) {
        return res.status(422).json({
          error: "Preflight failed",
          code: "PREFLIGHT_FAILED",
          jobId,
          artifacts: {
            preflight: "preflight.json",
            layers: "layers.json",
            plates: "plates.json",
          },
          details: {
            summary:
              preflight.violations[0] || "One or more preflight checks failed.",
            checks: preflight.checks, // structured pass/fail list
            violations: preflight.violations, // error-level messages
            warnings: preflight.warnings, // advisory messages
            expectations: preflight.expectations, // what "good" looks like
            detected: preflight.detected, // raw signals (ocg, separations, overprint)
          },
        });
      }

      // If preflight passes, enqueue the job
      const jobData = {
        jobId,
        filePath: finalPath,
        originalName: file.originalname,
        fileSize: tmpStats.size,
        options: {
          dpi: options.dpi || parseInt(process.env.DEFAULT_DPI || "600", 10),
          extractVector: options.extractVector !== false,
          enableOCG: options.enableOCG !== false,
        },
        submittedAt: new Date().toISOString(),
        submittedBy: req.ip,
      };

      const attempts = parseInt(process.env.MAX_JOB_ATTEMPTS || "3", 10);
      const backoff = parseInt(process.env.BACKOFF_DELAY_MS || "5000", 10);
      const timeout = parseInt(process.env.JOB_TIMEOUT_MS || "300000", 10);

      const job = await parseQueue.add("parse", jobData, {
        attempts,
        backoff: { type: "fixed", delay: backoff },
        timeout,
        removeOnComplete: true,
        removeOnFail: true,
      });

      return res.status(202).json({
        message: "Job accepted",
        jobId,
        queueId: job.id,
        preflight: { pass: true, violations: [], warnings: preflight.warnings },
      });
    } catch (error) {
      logger.error("Job submission failed:", error);
      // clean temp if needed
      try {
        if (req.file?.path && (await fs.pathExists(req.file.path)))
          await fs.remove(req.file.path);
      } catch {}
      return res
        .status(500)
        .json({ error: "Internal error", code: "JOB_SUBMIT_ERROR" });
    }
  }
);

// Get job status
app.get("/jobs/:jobId/status", authenticateRequest, async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const jobDir = path.join(UPLOAD_DIR, jobId);

    // Check if job directory exists
    if (!(await fs.pathExists(jobDir))) {
      return res.status(404).json({
        error: "Job not found",
        jobId,
        code: "JOB_NOT_FOUND",
      });
    }

    // Check if result file exists (completed)
    const resultPath = path.join(jobDir, "result.json");
    if (await fs.pathExists(resultPath)) {
      const stats = await fs.stat(resultPath);
      return res.json({
        status: "completed",
        jobId,
        completedAt: stats.mtime.toISOString(),
      });
    }

    // Check if error file exists (failed)
    const errorPath = path.join(jobDir, "error.json");
    if (await fs.pathExists(errorPath)) {
      const errorData = await fs.readJson(errorPath);
      return res.json({
        status: "failed",
        jobId,
        error: errorData.message,
        failedAt: errorData.failedAt,
      });
    }

    // Check queue status for active/waiting jobs
    try {
      const waiting = await parseQueue.getWaiting();
      const active = await parseQueue.getActive();

      const waitingJob = waiting.find(
        (job) => job.data && job.data.jobId === jobId
      );
      const activeJob = active.find(
        (job) => job.data && job.data.jobId === jobId
      );

      if (waitingJob) {
        return res.json({
          status: "waiting",
          jobId,
          queuePosition: waiting.indexOf(waitingJob) + 1,
          totalWaiting: waiting.length,
        });
      }

      if (activeJob) {
        const progress = await activeJob.progress().catch(() => 0);
        return res.json({
          status: "processing",
          jobId,
          progress: progress || 0,
        });
      }
    } catch (queueError) {
      logger.warn("Queue status check failed:", queueError);
    }

    // Job exists but no clear status - assume processing
    return res.json({
      status: "processing",
      jobId,
      progress: 0,
    });
  } catch (error) {
    logger.error("Status check failed:", error);
    res.status(500).json({
      error: "Status check failed",
      code: "STATUS_CHECK_ERROR",
    });
  }
});

app.get("/status/:jobId", authenticateRequest, async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const jobDir = path.join(UPLOAD_DIR, jobId);

    // 404 if job directory doesn't exist
    if (!(await fs.pathExists(jobDir))) {
      return res
        .status(404)
        .json({ error: "Job not found", jobId, code: "JOB_NOT_FOUND" });
    }

    // Completed?
    const resultPath = path.join(jobDir, "result.json");
    if (await fs.pathExists(resultPath)) {
      const stats = await fs.stat(resultPath);
      return res.json({
        status: "completed",
        jobId,
        completedAt: stats.mtime.toISOString(),
      });
    }

    // Failed?
    const errorPath = path.join(jobDir, "error.json");
    if (await fs.pathExists(errorPath)) {
      const errorData = await fs.readJson(errorPath);
      return res.json({
        status: "failed",
        jobId,
        error: errorData.message,
        failedAt: errorData.failedAt,
      });
    }

    // Queue state
    try {
      const waiting = await parseQueue.getWaiting();
      const active = await parseQueue.getActive();
      const waitingJob = waiting.find((j) => j.data && j.data.jobId === jobId);
      const activeJob = active.find((j) => j.data && j.data.jobId === jobId);

      if (waitingJob) {
        return res.json({
          status: "waiting",
          jobId,
          queuePosition: waiting.indexOf(waitingJob) + 1,
          totalWaiting: waiting.length,
        });
      }
      if (activeJob) {
        const progress = await activeJob.progress().catch(() => 0);
        return res.json({
          status: "processing",
          jobId,
          progress: progress || 0,
        });
      }
    } catch (queueError) {
      // non-fatal
    }

    // Fallback
    return res.json({ status: "processing", jobId, progress: 0 });
  } catch (error) {
    return res
      .status(500)
      .json({ error: "Status check failed", code: "STATUS_CHECK_ERROR" });
  }
});

// Get job result
app.get("/jobs/:jobId/result", authenticateRequest, async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const jobDir = path.join(UPLOAD_DIR, jobId);
    const resultPath = path.join(jobDir, "result.json");

    if (!(await fs.pathExists(resultPath))) {
      // Check if job is still processing
      try {
        const active = await parseQueue.getActive();
        const isProcessing = active.some(
          (job) => job.data && job.data.jobId === jobId
        );

        if (isProcessing) {
          return res.status(202).json({
            message: "Job is still processing",
            jobId,
            code: "JOB_PROCESSING",
          });
        }
      } catch (queueError) {
        logger.warn("Queue check failed in result fetch:", queueError);
      }

      // Check if there's an error file instead
      const errorPath = path.join(jobDir, "error.json");
      if (await fs.pathExists(errorPath)) {
        return res.status(422).json({
          error: "Job failed during processing",
          jobId,
          code: "JOB_FAILED",
        });
      }

      return res.status(404).json({
        error: "Result not found",
        jobId,
        code: "RESULT_NOT_FOUND",
      });
    }

    const result = await fs.readJson(resultPath);
    res.json({
      success: true,
      jobId,
      result,
    });
  } catch (error) {
    logger.error("Result fetch failed:", error);
    res.status(500).json({
      error: "Failed to fetch result",
      code: "RESULT_FETCH_ERROR",
    });
  }
});

// Alias: GET /jobs/:jobId/result.json  (same behavior as /jobs/:jobId/result)
app.get("/jobs/:jobId/result.json", authenticateRequest, async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const jobDir = path.join(UPLOAD_DIR, jobId);
    const resultPath = path.join(jobDir, "result.json");

    if (!(await fs.pathExists(resultPath))) {
      // Still processing?
      try {
        const active = await parseQueue.getActive();
        const isProcessing = active.some(
          (job) => job.data && job.data.jobId === jobId
        );
        if (isProcessing) {
          return res
            .status(202)
            .json({
              message: "Job is still processing",
              jobId,
              code: "JOB_PROCESSING",
            });
        }
      } catch (_) {}
      // Failed?
      const errorPath = path.join(jobDir, "error.json");
      if (await fs.pathExists(errorPath)) {
        return res
          .status(422)
          .json({
            error: "Job failed during processing",
            jobId,
            code: "JOB_FAILED",
          });
      }
      // Not found
      return res
        .status(404)
        .json({ error: "Result not found", jobId, code: "RESULT_NOT_FOUND" });
    }

    const result = await fs.readJson(resultPath);
    return res.json({ success: true, jobId, result });
  } catch (error) {
    return res
      .status(500)
      .json({ error: "Failed to fetch result", code: "RESULT_FETCH_ERROR" });
  }
});

// Get job preflight results (for failed jobs)
app.get("/jobs/:jobId/preflight", authenticateRequest, async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const preflightPath = path.join(UPLOAD_DIR, jobId, "preflight.json");

    if (!(await fs.pathExists(preflightPath))) {
      return res.status(404).json({
        error: "Preflight data not found",
        jobId,
        code: "PREFLIGHT_NOT_FOUND",
      });
    }

    const preflight = await fs.readJson(preflightPath);
    res.json({
      jobId,
      preflight,
    });
  } catch (error) {
    logger.error("Preflight fetch failed:", error);
    res.status(500).json({
      error: "Failed to fetch preflight data",
      code: "PREFLIGHT_FETCH_ERROR",
    });
  }
});

// Serve generated assets (unchanged)
app.get("/jobs/:jobId/assets/:filename", async (req, res) => {
  try {
    const filePath = path.join(
      UPLOAD_DIR,
      req.params.jobId,
      "assets",
      req.params.filename
    );
    if (!(await fs.pathExists(filePath))) {
      return res.status(404).json({ error: "Asset not found" });
    }
    res.sendFile(filePath);
  } catch (error) {
    logger.error("Asset serve error:", error);
    res
      .status(500)
      .json({ error: "Failed to serve asset", code: "ASSET_SERVE_FAILED" });
  }
});

// Health (kept)
app.get("/health", async (req, res) => {
  try {
    const waiting = await parseQueue.getWaiting();
    const active = await parseQueue.getActive();
    const completed = await parseQueue.getCompleted();
    const failed = await parseQueue.getFailed();
    const redisPing = await redis.ping();

    const health = {
      status: redisPing === "PONG" ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      queue: {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
      },
      config: {
        maxFileSize: process.env.MAX_FILE_SIZE || "100MB",
        workerConcurrency: process.env.WORKER_CONCURRENCY || "3",
        ttlDays: process.env.TTL_DAYS || "30",
        dpi: process.env.DEFAULT_DPI || "600",
        environment: process.env.NODE_ENV || "development",
      },
    };
    res.status(200).json(health);
  } catch (error) {
    logger.error("Health check error:", error);
    res.status(500).json({
      status: "unhealthy",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Parser API listening on :${PORT}`);
});

process.on("SIGTERM", async () => {
  await closeQueue();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await closeQueue();
  process.exit(0);
});
