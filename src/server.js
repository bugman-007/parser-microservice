// src/server.js - UPDATED TO USE ENHANCED PREFLIGHT AND PARSER
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
  runEnhancedPreflight,
  writeEnhancedPreflight,
  writeEnhancedLayers,
  writeEnhancedSeparations,
} from "./services/enhanced-preflight.js";

dotenv.config();

// __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8000;

// Enhanced logger
const logDir = process.env.LOG_DIR || "/var/log/parser";
await fs.ensureDir(logDir);
const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: "enhanced-parser-api" },
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

// Upload directory
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "./uploads");
await fs.ensureDir(UPLOAD_DIR);

// Initialize enhanced queue system
await initializeEnhancedQueue();
async function initializeEnhancedQueue() {
  await parseQueue.isReady();
  await parseQueue.resume();
  // Clear any paused states from previous runs
  await redis.del("bull:parse_jobs:paused");
  await redis.del("bull:parse_jobs:meta-paused");
  console.log("🚀 Enhanced queue system initialized");
}

// Security & middleware
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

// Enhanced upload configuration
const upload = multer({
  dest: "/tmp/",
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || "104857600", 10), // 100MB
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const validTypes = [".ai", ".pdf"];
    const ext = path.extname(file.originalname).toLowerCase();
    const isValidType = validTypes.includes(ext) || file.mimetype === "application/pdf";
    
    if (!isValidType) {
      const error = new Error(
        "Invalid file type. Only Adobe Illustrator (.ai) and PDF (.pdf) files are allowed."
      );
      error.code = "INVALID_FILE_TYPE";
      return cb(error, false);
    }
    
    // Enhanced MIME type validation
    if (file.mimetype === "application/pdf" && ext !== ".pdf") {
      const error = new Error("File extension does not match MIME type.");
      error.code = "MIME_MISMATCH";
      return cb(error, false);
    }
    
    cb(null, true);
  },
});

// ===== ENHANCED ROUTES =====

/**
 * Enhanced job submission with comprehensive preflight validation
 * POST /jobs?jobId=uuid
 */
app.post(
  "/jobs",
  authenticateRequest,
  upload.single("file"),
  async (req, res) => {
    let jobId, jobDir;
    const startTime = Date.now();
    
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

      logger.info(`🚀 Enhanced job submission: ${jobId}`, {
        jobId,
        originalName: file?.originalname,
        fileSize: file?.size,
        options
      });

      if (!file) {
        return res.status(400).json({ 
          error: "No file uploaded", 
          code: "NO_FILE",
          jobId 
        });
      }

      // Validate uploaded file
      const tmpStats = await fs.stat(file.path);
      if (!tmpStats.isFile()) {
        await fs.remove(file.path);
        return res.status(400).json({ 
          error: "Invalid file upload", 
          code: "INVALID_FILE",
          jobId 
        });
      }

      // Create job directory structure
      jobDir = path.join(UPLOAD_DIR, jobId);
      await fs.ensureDir(jobDir);
      await fs.ensureDir(path.join(jobDir, "assets"));

      // Move file to final location
      const finalPath = path.join(jobDir, file.originalname);
      await fs.move(file.path, finalPath, { overwrite: true });

      logger.info(`📁 File moved to: ${finalPath}`);

      // ---- Enhanced Preflight Validation ----
      logger.info(`🔍 Running enhanced preflight validation: ${jobId}`);
      
      const preflight = await runEnhancedPreflight(finalPath);
      
      // Write preflight results
      await writeEnhancedPreflight(jobDir, preflight);
      
      // Write detailed layer and separation analysis
      if (preflight.detected.layerAnalysis) {
        await writeEnhancedLayers(jobDir, preflight.detected.layerAnalysis);
      }
      
      if (preflight.detected.separations) {
        await writeEnhancedSeparations(
          jobDir,
          preflight.detected.separations,
          preflight.detected.separationMapping
        );
      }

      // Enhanced preflight decision logic
      if (!preflight.pass) {
        logger.warn(`❌ Enhanced preflight failed: ${jobId}`, {
          violations: preflight.violations,
          recommendations: preflight.recommendations
        });

        return res.status(422).json({
          error: "Enhanced preflight validation failed",
          code: "ENHANCED_PREFLIGHT_FAILED",
          jobId,
          preflight: {
            pass: false,
            violations: preflight.violations,
            warnings: preflight.warnings,
            recommendations: preflight.recommendations
          },
          artifacts: {
            preflight: "preflight.json",
            layers: "layers.json", 
            separations: "separations.json"
          },
          details: {
            summary: preflight.violations[0] || "One or more enhanced validation checks failed.",
            checks: preflight.checks,
            violations: preflight.violations,
            warnings: preflight.warnings,
            recommendations: preflight.recommendations,
            expectations: preflight.expectations,
            detected: {
              ocgNames: preflight.detected.ocgNames,
              separations: preflight.detected.separations,
              requestedFinishes: preflight.detected.requestedFinishes,
              layerStats: {
                total: (preflight.detected.layerAnalysis?.validLayers?.length || 0) + 
                       (preflight.detected.layerAnalysis?.invalidLayers?.length || 0),
                valid: preflight.detected.layerAnalysis?.validLayers?.length || 0,
                invalid: preflight.detected.layerAnalysis?.invalidLayers?.length || 0
              }
            }
          },
          processingTime: Date.now() - startTime
        });
      }

      // Preflight passed - enqueue for enhanced processing
      const jobData = {
        jobId,
        filePath: finalPath,
        originalName: file.originalname,
        fileSize: tmpStats.size,
        options: {
          dpi: options.dpi || parseInt(process.env.DEFAULT_DPI || "600", 10),
          extractVector: options.extractVector !== false,
          enableOCG: options.enableOCG !== false,
          enableDebug: options.enableDebug || process.env.ENABLE_DEBUG === 'true'
        },
        submittedAt: new Date().toISOString(),
        submittedBy: req.ip,
        preflightData: {
          layerCount: preflight.detected.layerAnalysis?.validLayers?.length || 0,
          finishes: preflight.detected.requestedFinishes,
          separationCount: preflight.detected.separations?.length || 0
        }
      };

      const attempts = parseInt(process.env.MAX_JOB_ATTEMPTS || "3", 10);
      const backoff = parseInt(process.env.BACKOFF_DELAY_MS || "5000", 10);
      const timeout = parseInt(process.env.JOB_TIMEOUT_MS || "300000", 10);

      const job = await parseQueue.add("parse", jobData, {
        attempts,
        backoff: { type: "exponential", delay: backoff },
        timeout,
        removeOnComplete: 5,  // Keep last 5 completed jobs
        removeOnFail: 3,      // Keep last 3 failed jobs
      });

      const processingTime = Date.now() - startTime;

      logger.info(`✅ Enhanced job accepted: ${jobId}`, {
        queueId: job.id,
        processingTime,
        layerCount: jobData.preflightData.layerCount,
        finishes: jobData.preflightData.finishes
      });

      return res.status(202).json({
        message: "Enhanced job accepted for processing",
        jobId,
        queueId: job.id,
        preflight: { 
          pass: true, 
          violations: [], 
          warnings: preflight.warnings,
          layerCount: jobData.preflightData.layerCount,
          finishes: jobData.preflightData.finishes,
          separationCount: jobData.preflightData.separationCount
        },
        estimatedProcessingTime: "30-180 seconds (enhanced processing)",
        processingTime,
        version: "enhanced_v2.0"
      });

    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      logger.error("Enhanced job submission failed:", error, {
        jobId,
        processingTime,
        errorType: error.constructor.name
      });

      // Cleanup on error
      try {
        if (req.file?.path && (await fs.pathExists(req.file.path))) {
          await fs.remove(req.file.path);
        }
        if (jobDir && (await fs.pathExists(jobDir))) {
          await fs.remove(jobDir);
        }
      } catch (cleanupError) {
        logger.warn("Cleanup error:", cleanupError);
      }

      return res.status(500).json({ 
        error: "Enhanced job submission failed", 
        code: "JOB_SUBMIT_ERROR",
        message: error.message,
        jobId,
        processingTime,
        version: "enhanced_v2.0"
      });
    }
  }
);

/**
 * Enhanced job status endpoint
 * GET /jobs/:jobId/status
 */
app.get("/jobs/:jobId/status", authenticateRequest, async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobDir = path.join(UPLOAD_DIR, jobId);

    logger.debug(`📊 Enhanced status check: ${jobId}`);

    // Check if job directory exists
    if (!(await fs.pathExists(jobDir))) {
      return res.status(404).json({
        error: "Job not found",
        jobId,
        code: "JOB_NOT_FOUND",
        version: "enhanced_v2.0"
      });
    }

    // Check completion status
    const resultPath = path.join(jobDir, "result.json");
    if (await fs.pathExists(resultPath)) {
      const stats = await fs.stat(resultPath);
      const result = await fs.readJson(resultPath);
      
      return res.json({
        status: "completed",
        jobId,
        completedAt: stats.mtime.toISOString(),
        confidence: result.parsing?.confidence || 0,
        layersProcessed: result.parsing?.layersProcessed || 0,
        assetsGenerated: result.maps ? Object.keys(result.maps).length : 0,
        version: "enhanced_v2.0"
      });
    }

    // Check failure status
    const errorPath = path.join(jobDir, "error.json");
    if (await fs.pathExists(errorPath)) {
      const errorData = await fs.readJson(errorPath);
      return res.json({
        status: "failed",
        jobId,
        error: errorData.message,
        errorPhase: errorData.parsingContext?.errorPhase || 'unknown',
        failedAt: errorData.failedAt,
        version: "enhanced_v2.0"
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
          estimatedWaitTime: `${waiting.indexOf(waitingJob) * 60} seconds`,
          version: "enhanced_v2.0"
        });
      }

      if (activeJob) {
        const progress = await activeJob.progress().catch(() => 0);
        const progressData = await activeJob.data;
        
        return res.json({
          status: "processing",
          jobId,
          progress: Math.round(progress) || 0,
          currentStage: determineProcessingStage(progress),
          preflightInfo: progressData?.preflightData || {},
          version: "enhanced_v2.0"
        });
      }
    } catch (queueError) {
      logger.warn("Enhanced queue status check failed:", queueError);
    }

    // Job exists but status unclear - assume processing
    return res.json({
      status: "processing",
      jobId,
      progress: 0,
      currentStage: "initializing",
      version: "enhanced_v2.0"
    });

  } catch (error) {
    logger.error("Enhanced status check failed:", error);
    res.status(500).json({
      error: "Status check failed",
      code: "STATUS_CHECK_ERROR",
      message: error.message,
      version: "enhanced_v2.0"
    });
  }
});

/**
 * Enhanced job result endpoint  
 * GET /jobs/:jobId/result
 */
app.get("/jobs/:jobId/result", authenticateRequest, async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobDir = path.join(UPLOAD_DIR, jobId);
    const resultPath = path.join(jobDir, "result.json");

    logger.debug(`📖 Enhanced result fetch: ${jobId}`);

    if (!(await fs.pathExists(resultPath))) {
      // Check if job is still processing
      try {
        const active = await parseQueue.getActive();
        const isProcessing = active.some(
          (job) => job.data && job.data.jobId === jobId
        );

        if (isProcessing) {
          return res.status(202).json({
            message: "Enhanced job is still processing",
            jobId,
            code: "JOB_PROCESSING",
            version: "enhanced_v2.0"
          });
        }
      } catch (queueError) {
        logger.warn("Queue check failed in enhanced result fetch:", queueError);
      }

      // Check for error file
      const errorPath = path.join(jobDir, "error.json");
      if (await fs.pathExists(errorPath)) {
        const errorData = await fs.readJson(errorPath);
        return res.status(422).json({
          error: "Enhanced job failed during processing", 
          jobId,
          code: "JOB_FAILED",
          errorDetails: {
            phase: errorData.parsingContext?.errorPhase || 'unknown',
            lastStep: errorData.parsingContext?.lastStep || 'unknown',
            message: errorData.message
          },
          version: "enhanced_v2.0"
        });
      }

      return res.status(404).json({
        error: "Enhanced result not found",
        jobId,
        code: "RESULT_NOT_FOUND",
        version: "enhanced_v2.0"
      });
    }

    // Load and return enhanced result
    const result = await fs.readJson(resultPath);
    
    // Add enhanced metadata
    const enhancedResult = {
      ...result,
      fetchedAt: new Date().toISOString(),
      version: "enhanced_v2.0",
      parserVersion: result.parsing?.version || "enhanced_ocg_v2",
      
      // Enhanced summary
      summary: {
        confidence: result.parsing?.confidence || 0,
        layersFound: result.parsing?.layersFound || 0,
        layersProcessed: result.parsing?.layersProcessed || 0,
        assetsGenerated: result.maps ? Object.keys(result.maps).length : 0,
        processingTime: result.processing?.totalTime || 0,
        qualityScore: result.quality?.overall || 0,
        namingCompliant: result.validation?.namingCompliant || false
      }
    };

    logger.info(`✅ Enhanced result delivered: ${jobId}`, {
      confidence: enhancedResult.summary.confidence,
      layersProcessed: enhancedResult.summary.layersProcessed,
      qualityScore: enhancedResult.summary.qualityScore
    });

    res.json({
      success: true,
      jobId,
      result: enhancedResult
    });

  } catch (error) {
    logger.error("Enhanced result fetch failed:", error);
    res.status(500).json({
      error: "Failed to fetch enhanced result",
      code: "RESULT_FETCH_ERROR",
      message: error.message,
      version: "enhanced_v2.0"
    });
  }
});

/**
 * Enhanced preflight results endpoint
 * GET /jobs/:jobId/preflight
 */
app.get("/jobs/:jobId/preflight", authenticateRequest, async (req, res) => {
  try {
    const { jobId } = req.params;
    const preflightPath = path.join(UPLOAD_DIR, jobId, "preflight.json");

    if (!(await fs.pathExists(preflightPath))) {
      return res.status(404).json({
        error: "Enhanced preflight data not found",
        jobId,
        code: "PREFLIGHT_NOT_FOUND",
        version: "enhanced_v2.0"
      });
    }

    const preflight = await fs.readJson(preflightPath);
    
    // Also load related analysis files if available
    const layersPath = path.join(UPLOAD_DIR, jobId, "layers.json");
    const separationsPath = path.join(UPLOAD_DIR, jobId, "separations.json");
    
    const enhancedPreflight = {
      ...preflight,
      relatedData: {}
    };
    
    if (await fs.pathExists(layersPath)) {
      enhancedPreflight.relatedData.layers = await fs.readJson(layersPath);
    }
    
    if (await fs.pathExists(separationsPath)) {
      enhancedPreflight.relatedData.separations = await fs.readJson(separationsPath);
    }

    res.json({
      jobId,
      preflight: enhancedPreflight,
      version: "enhanced_v2.0"
    });

  } catch (error) {
    logger.error("Enhanced preflight fetch failed:", error);
    res.status(500).json({
      error: "Failed to fetch enhanced preflight data",
      code: "PREFLIGHT_FETCH_ERROR",
      message: error.message,
      version: "enhanced_v2.0"
    });
  }
});

/**
 * Legacy compatibility endpoints
 */
app.get("/status/:jobId", authenticateRequest, async (req, res) => {
  // Redirect to enhanced status endpoint
  req.url = `/jobs/${req.params.jobId}/status`;
  return app.handle(req, res);
});

app.get("/jobs/:jobId/result.json", authenticateRequest, async (req, res) => {
  // Redirect to enhanced result endpoint  
  req.url = `/jobs/${req.params.jobId}/result`;
  return app.handle(req, res);
});

/**
 * Enhanced asset serving with better caching
 * GET /jobs/:jobId/assets/:filename
 */
app.get("/jobs/:jobId/assets/:filename", async (req, res) => {
  try {
    const { jobId, filename } = req.params;
    const filePath = path.join(UPLOAD_DIR, jobId, "assets", filename);

    if (!(await fs.pathExists(filePath))) {
      return res.status(404).json({ 
        error: "Enhanced asset not found",
        jobId,
        filename,
        version: "enhanced_v2.0"
      });
    }

    // Enhanced caching headers
    const stats = await fs.stat(filePath);
    const etag = `"${jobId}-${filename}-${stats.mtime.getTime()}"`;
    
    // Check if client has cached version
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    // Set enhanced cache headers
    res.set({
      'Content-Type': getContentType(filename),
      'Content-Length': stats.size,
      'Cache-Control': 'public, max-age=31536000, immutable', // 1 year cache
      'ETag': etag,
      'Last-Modified': stats.mtime.toUTCString(),
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Asset-Version': 'enhanced_v2.0'
    });

    // Stream the file
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);

    logger.debug(`📎 Enhanced asset served: ${jobId}/${filename}`);

  } catch (error) {
    logger.error("Enhanced asset serve error:", error);
    res.status(500).json({
      error: "Failed to serve enhanced asset",
      code: "ASSET_SERVE_FAILED", 
      message: error.message,
      version: "enhanced_v2.0"
    });
  }
});

/**
 * Enhanced health check endpoint
 * GET /health
 */
app.get("/health", async (req, res) => {
  try {
    const waiting = await parseQueue.getWaiting();
    const active = await parseQueue.getActive();
    const completed = await parseQueue.getCompleted();
    const failed = await parseQueue.getFailed();
    const redisPing = await redis.ping();

    // Enhanced health metrics
    const health = {
      status: redisPing === "PONG" ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      version: "enhanced_v2.0",
      parserEngine: "enhanced_ocg_parser",
      
      queue: {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        throughput: {
          completedLast24h: completed.length, // Simplified for demo
          avgProcessingTime: "60-120 seconds"
        }
      },
      
      config: {
        maxFileSize: process.env.MAX_FILE_SIZE || "100MB",
        workerConcurrency: process.env.WORKER_CONCURRENCY || "3",
        ttlDays: process.env.TTL_DAYS || "30",
        dpi: process.env.DEFAULT_DPI || "600",
        environment: process.env.NODE_ENV || "development",
        debugMode: process.env.ENABLE_DEBUG || "false"
      },
      
      capabilities: {
        realOCGExtraction: true,
        strictNamingValidation: true,
        enhancedPreflight: true,
        qualityMetrics: true,
        supportedEffects: ["print", "foil_*", "spot_uv", "emboss", "deboss", "die_cut"]
      },
      
      system: {
        uptime: Math.floor(process.uptime()),
        memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
        nodeVersion: process.version
      }
    };

    res.status(200).json(health);

  } catch (error) {
    logger.error("Enhanced health check error:", error);
    res.status(500).json({
      status: "unhealthy",
      error: error.message,
      timestamp: new Date().toISOString(),
      version: "enhanced_v2.0"
    });
  }
});

/**
 * Enhanced root endpoint
 */
app.get("/", (req, res) => {
  res.json({
    service: "SilkCards Enhanced OCG Parser API",
    version: "enhanced_v2.0",
    documentation: "https://docs.silkcards3d.com/enhanced-api",
    status: "running",
    
    endpoints: {
      health: "GET /health",
      submitJob: "POST /jobs",
      jobStatus: "GET /jobs/:jobId/status", 
      jobResult: "GET /jobs/:jobId/result",
      jobPreflight: "GET /jobs/:jobId/preflight",
      assets: "GET /jobs/:jobId/assets/:filename"
    },
    
    capabilities: [
      "Real OCG layer extraction",
      "Strict naming convention validation",
      "Enhanced preflight with actionable recommendations", 
      "High-accuracy material map generation",
      "Quality scoring and confidence metrics",
      "Comprehensive error reporting"
    ],
    
    namingConvention: {
      pattern: "(front|back)_layer_{index}_{effect}",
      allowedEffects: ["print", "foil_*", "spot_uv", "emboss", "deboss", "die_cut"],
      examples: [
        "front_layer_0_print",
        "front_layer_1_foil_gold",
        "front_layer_2_spot_uv",
        "back_layer_0_print"
      ]
    },
    
    limits: {
      maxFileSize: "100MB",
      shareExpiry: "30 days", 
      supportedFormats: [".ai", ".pdf"],
      processingTimeout: "300 seconds"
    }
  });
});

// Helper functions
function determineProcessingStage(progress) {
  if (progress < 15) return "validation";
  if (progress < 30) return "ocg_extraction";
  if (progress < 50) return "layer_processing";
  if (progress < 70) return "texture_generation";
  if (progress < 90) return "material_mapping";
  return "finalizing";
}

function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const contentTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.json': 'application/json'
  };
  return contentTypes[ext] || 'application/octet-stream';
}

// Enhanced error handling middleware
app.use((err, req, res, next) => {
  const timestamp = new Date().toISOString();
  
  logger.error(`${timestamp} | ENHANCED ERROR:`, err.message, {
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  // Enhanced CORS error handling
  if (err.message.includes('CORS policy')) {
    return res.status(403).json({
      success: false,
      error: 'CORS Error',
      message: 'Origin not allowed by enhanced API',
      origin: req.get('Origin'),
      allowedOrigins: allowedOrigins,
      version: "enhanced_v2.0"
    });
  }

  // Enhanced file upload error handling
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: 'File too large for enhanced processing',
      message: 'Maximum file size is 100MB',
      limit: '100MB',
      version: "enhanced_v2.0"
    });
  }

  if (err.code === 'INVALID_FILE_TYPE') {
    return res.status(400).json({
      success: false,
      error: 'Invalid file type for enhanced processing',
      message: 'Only Adobe Illustrator (.ai) and PDF (.pdf) files are supported',
      supportedTypes: ['.ai', '.pdf'],
      version: "enhanced_v2.0"
    });
  }

  // Generic enhanced error response
  res.status(err.status || 500).json({
    success: false,
    error: err.name || 'Enhanced Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 
      'Something went wrong in enhanced processing' : 
      err.message,
    timestamp,
    version: "enhanced_v2.0",
    ...(process.env.NODE_ENV !== 'production' && { 
      stack: err.stack,
      requestId: req.headers['x-request-id']
    })
  });
});

// Enhanced 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Enhanced endpoint not found',
    message: `Route ${req.method} ${req.originalUrl} not found in enhanced API`,
    availableRoutes: [
      'GET /',
      'GET /health', 
      'POST /jobs',
      'GET /jobs/:jobId/status',
      'GET /jobs/:jobId/result',
      'GET /jobs/:jobId/preflight',
      'GET /jobs/:jobId/assets/:filename'
    ],
    version: "enhanced_v2.0"
  });
});

// Enhanced graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('👋 SIGTERM received, shutting down enhanced server gracefully...');
  await closeQueue();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('👋 SIGINT received, shutting down enhanced server gracefully...');
  await closeQueue();
  process.exit(0);
});

// Enhanced server startup
app.listen(PORT, () => {
  console.log('🚀 SilkCards Enhanced OCG Parser API v2.0 running!');
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`📁 Uploads: ${UPLOAD_DIR}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔍 Health check: http://localhost:${PORT}/health`);
  console.log(`🎯 Features: Real OCG extraction, strict validation, enhanced quality metrics`);
  console.log('✅ Enhanced system ready for high-accuracy parsing!');
});

export default app;