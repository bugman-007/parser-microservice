// src/worker.js - UPDATED TO USE ENHANCED OCG PARSER
import fs from "fs-extra";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import EnhancedOCGParser from "./services/improved-parser.js";
import parseQueue, { redis, closeQueue } from "./services/queue.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Worker concurrency
const concurrency = parseInt(process.env.WORKER_CONCURRENCY || "3", 10);

console.log("🏭 Enhanced Parser Worker Configuration:");
console.log(`  Concurrency: ${concurrency}`);
console.log(`  DPI: ${process.env.DEFAULT_DPI || "600"}`);
console.log(`  Upload Dir: ${process.env.UPLOAD_DIR || "/opt/parser/uploads"}`);
console.log(`  Debug Mode: ${process.env.ENABLE_DEBUG || "false"}`);
console.log(`  Redis: ${process.env.REDIS_HOST || "127.0.0.1"}:${process.env.REDIS_PORT || 6379}/${process.env.REDIS_DB || 0}`);

// Enhanced parser instance
const parser = new EnhancedOCGParser({
  dpi: parseInt(process.env.DEFAULT_DPI || "600"),
  uploadDir: process.env.UPLOAD_DIR || "/opt/parser/uploads",
  enableDebug: process.env.ENABLE_DEBUG === 'true'
});

// Initialize queue
async function initializeQueue() {
  try {
    console.log("🔧 Initializing enhanced queue system...");
    await redis.ping();
    console.log("✅ Redis connection established");
    
    await parseQueue.isReady();
    console.log("✅ Bull queue ready");

    await parseQueue.resume();
    console.log("▶️ Queue resumed - ready for enhanced processing");

    // Clean old completed/failed jobs
    await parseQueue.clean(24 * 60 * 60 * 1000, "completed", 10);
    await parseQueue.clean(24 * 60 * 60 * 1000, "failed", 5);

    // Log queue status
    const waiting = await parseQueue.getWaiting();
    const active = await parseQueue.getActive();
    const completed = await parseQueue.getCompleted();
    const failed = await parseQueue.getFailed();

    console.log("📊 Enhanced Queue Status:");
    console.log(`  Waiting: ${waiting.length}`);
    console.log(`  Active: ${active.length}`);
    console.log(`  Completed: ${completed.length}`);
    console.log(`  Failed: ${failed.length}`);

    return true;
  } catch (error) {
    console.error("❌ Enhanced queue initialization failed:", error);
    throw error;
  }
}

// Enhanced job processor
parseQueue.process("parse", concurrency, async (job) => {
  const { jobId, filePath, originalName, fileSize, options, submittedAt } = job.data;

  console.log(`🚀 Processing with Enhanced OCG Parser: ${jobId} (${originalName})`);
  console.log(`📊 File size: ${(fileSize / 1024 / 1024).toFixed(2)}MB`);

  const startTime = Date.now();
  let processingSteps = [];

  try {
    // Step 1: Validation
    await job.progress(5);
    processingSteps.push({ step: "validation", timestamp: Date.now() });

    if (!(await fs.pathExists(filePath))) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileStats = await fs.stat(filePath);
    console.log(`📁 Processing file: ${originalName} (${(fileStats.size / 1024 / 1024).toFixed(2)}MB)`);

    // Step 2: Setup
    await job.progress(10);
    processingSteps.push({ step: "setup", timestamp: Date.now() });

    const jobDir = path.dirname(filePath);
    const assetsDir = path.join(jobDir, "assets");
    await fs.ensureDir(assetsDir);

    // Step 3: Enhanced OCG Parsing
    await job.progress(15);
    processingSteps.push({ step: "enhanced_ocg_parsing_start", timestamp: Date.now() });

    const updateProgress = async (stage, baseProgress = 15) => {
      const progressMap = {
        pdf_loading: 20,
        ocg_extraction: 30,
        layer_validation: 40,
        layer_processing: 55,
        texture_generation: 70,
        albedo_generation: 80,
        material_mapping: 90,
        finalizing: 95,
      };
      
      const progress = progressMap[stage] || baseProgress;
      await job.progress(progress);
      console.log(`📈 Enhanced Job ${jobId}: ${stage} (${progress}%)`);
      
      processingSteps.push({ step: stage, timestamp: Date.now(), progress });
    };

    // Parse with enhanced OCG parser and progress tracking
    const result = await parseWithEnhancedProgress(
      parser,
      jobId,
      filePath,
      options,
      updateProgress
    );

    await job.progress(92);
    processingSteps.push({ step: "parsing_complete", timestamp: Date.now() });

    // Step 4: Quality validation
    await job.progress(95);
    processingSteps.push({ step: "quality_validation", timestamp: Date.now() });

    const qualityScore = await validateEnhancedParseResult(result, assetsDir);
    result.quality = qualityScore;

    // Step 5: Finalization
    result.processing = {
      ...(result.parsing || {}),
      steps: processingSteps,
      totalTime: Date.now() - startTime,
      workerPid: process.pid,
      memoryUsage: process.memoryUsage(),
      completedAt: new Date().toISOString(),
      version: "2.0.0",
      parserVersion: "enhanced_ocg_v2",
      confidence: result.parsing?.confidence || 0.5
    };

    await job.progress(98);
    const resultPath = path.join(jobDir, "result.json");
    await fs.writeJson(resultPath, result, { spaces: 2 });

    // Step 6: Cleanup
    await job.progress(100);
    processingSteps.push({ step: "cleanup", timestamp: Date.now() });
    
    await cleanupTempFiles(jobDir);

    const totalTime = Date.now() - startTime;

    console.log(`✅ Enhanced job completed: ${jobId}`);
    console.log(`⏱️ Total time: ${(totalTime / 1000).toFixed(2)}s`);
    console.log(`🎯 Quality score: ${(qualityScore.overall * 100).toFixed(1)}%`);
    console.log(`🎨 Layers processed: ${result.parsing?.layersProcessed || 0}/${result.parsing?.layersFound || 0}`);
    console.log(`📊 Assets generated: ${result.maps ? Object.keys(result.maps).length : 0}`);
    console.log(`🔍 Naming compliance: ${result.validation?.namingCompliant ? '✅' : '❌'}`);

    return {
      success: true,
      jobId,
      processingTime: totalTime,
      qualityScore,
      layersProcessed: result.parsing?.layersProcessed || 0,
      layersFound: result.parsing?.layersFound || 0,
      assetsGenerated: result.maps ? Object.keys(result.maps).length : 0,
      confidence: result.parsing?.confidence || 0.5,
      namingCompliant: result.validation?.namingCompliant || false,
      parserVersion: "enhanced_ocg_v2"
    };

  } catch (error) {
    const totalTime = Date.now() - startTime;

    console.error(`❌ Enhanced job failed: ${jobId}`, error);
    console.log(`⏱️ Failed after: ${(totalTime / 1000).toFixed(2)}s`);

    // Enhanced error details with parsing context
    const errorDetails = {
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      processingSteps,
      processingTime: totalTime,
      jobId,
      originalName,
      fileSize,
      failedAt: new Date().toISOString(),
      workerPid: process.pid,
      memoryUsage: process.memoryUsage(),
      parserVersion: "enhanced_ocg_v2",
      errorType: error.constructor.name,
      // Enhanced error context
      parsingContext: {
        lastStep: processingSteps[processingSteps.length - 1]?.step || 'unknown',
        totalSteps: processingSteps.length,
        errorPhase: determineErrorPhase(processingSteps, error)
      }
    };

    try {
      const errorLogPath = path.join(path.dirname(filePath), "error.json");
      await fs.writeJson(errorLogPath, errorDetails, { spaces: 2 });
    } catch (logError) {
      console.error("Failed to save enhanced error log:", logError);
    }

    throw error;
  }
});

// Enhanced progress tracking with detailed stages
async function parseWithEnhancedProgress(parser, jobId, filePath, options, updateProgress) {
  try {
    await updateProgress("pdf_loading");
    
    // Hook into parser progress if possible
    const enhancedOptions = {
      ...options,
      progressCallback: updateProgress
    };
    
    const result = await parser.parseFile(jobId, filePath, enhancedOptions);
    
    await updateProgress("finalizing");
    return result;
    
  } catch (error) {
    console.error(`Enhanced parsing failed for ${jobId}:`, error.message);
    throw error;
  }
}

// Enhanced quality validation with detailed metrics
async function validateEnhancedParseResult(result, assetsDir) {
  const quality = {
    overall: 0.3, // Lower base for enhanced validation
    dimensions: 0,
    layers: 0,
    assets: 0,
    effects: 0,
    files: 0,
    naming: 0,
    confidence: 0
  };

  try {
    // 1. Dimensions validation
    if (result.dimensions && result.dimensions.width > 0 && result.dimensions.height > 0) {
      // Check if dimensions are reasonable for business cards
      const width = result.dimensions.width;
      const height = result.dimensions.height;
      
      if (width >= 80 && width <= 100 && height >= 45 && height <= 60) {
        quality.dimensions = 1.0; // Perfect business card dimensions
      } else if (width > 30 && width < 200 && height > 30 && height < 200) {
        quality.dimensions = 0.7; // Reasonable dimensions
      } else {
        quality.dimensions = 0.3; // Unusual but valid dimensions
      }
    }

    // 2. Layer processing validation
    const layersFound = result.parsing?.layersFound || 0;
    const layersProcessed = result.parsing?.layersProcessed || 0;
    
    if (layersFound > 0) {
      const processingRatio = layersProcessed / layersFound;
      quality.layers = Math.min(1.0, processingRatio * 1.2); // Bonus for high success rate
    }

    // 3. Naming compliance validation (new)
    if (result.validation?.namingCompliant) {
      quality.naming = 1.0;
    } else {
      const errors = result.validation?.errors?.length || 0;
      const warnings = result.validation?.warnings?.length || 0;
      
      if (errors === 0 && warnings > 0) {
        quality.naming = 0.7; // Only warnings
      } else if (errors > 0) {
        quality.naming = Math.max(0.1, 1.0 - (errors * 0.2)); // Penalize errors
      }
    }

    // 4. Asset generation validation
    if (result.maps) {
      const mapCount = Object.keys(result.maps).length;
      quality.assets = Math.min(1.0, mapCount * 0.2); // Up to 5 maps for max score

      // Validate actual file existence
      let existingAssets = 0;
      let totalExpectedAssets = 0;

      for (const [mapType, mapData] of Object.entries(result.maps)) {
        if (typeof mapData === "string") {
          totalExpectedAssets++;
          const assetPath = path.join(assetsDir, mapData);
          if (await fs.pathExists(assetPath)) existingAssets++;
        } else if (Array.isArray(mapData)) {
          totalExpectedAssets += mapData.length;
          for (const item of mapData) {
            const fileName = item.mask || item.file || item.maskFile;
            if (fileName) {
              const assetPath = path.join(assetsDir, fileName);
              if (await fs.pathExists(assetPath)) existingAssets++;
            }
          }
        }
      }

      quality.files = totalExpectedAssets > 0 ? existingAssets / totalExpectedAssets : 0;
    }

    // 5. Effect validation
    const effectTypes = ['foil', 'spot_uv', 'emboss', 'deboss', 'die_cut'];
    let detectedEffects = 0;
    
    if (result.maps) {
      for (const effectType of effectTypes) {
        if (result.maps[effectType] && result.maps[effectType].length > 0) {
          detectedEffects++;
        }
      }
    }
    
    quality.effects = Math.min(1.0, detectedEffects * 0.25); // Up to 4 effects for max score

    // 6. Parser confidence (new)
    quality.confidence = result.parsing?.confidence || 0.1;

    // Calculate overall quality with enhanced weighting
    const weights = {
      dimensions: 0.15,
      layers: 0.20,
      assets: 0.15,
      effects: 0.15,
      files: 0.10,
      naming: 0.15,  // New: naming compliance is important
      confidence: 0.10 // New: parser confidence matters
    };

    quality.overall = Object.entries(weights).reduce(
      (total, [metric, weight]) => total + quality[metric] * weight,
      0
    );

    // Bonus for exceptional results
    if (quality.naming === 1.0 && quality.files >= 0.9 && quality.confidence >= 0.8) {
      quality.overall = Math.min(1.0, quality.overall * 1.1); // 10% bonus
    }

  } catch (error) {
    console.warn("Enhanced quality validation error:", error);
    quality.overall = 0.1; // Very low score on validation error
  }

  return quality;
}

// Determine which phase the error occurred in
function determineErrorPhase(processingSteps, error) {
  if (processingSteps.length === 0) return 'initialization';
  
  const lastStep = processingSteps[processingSteps.length - 1].step;
  
  if (lastStep.includes('validation')) return 'validation';
  if (lastStep.includes('ocg') || lastStep.includes('layer')) return 'parsing';
  if (lastStep.includes('texture') || lastStep.includes('albedo')) return 'rendering';
  if (lastStep.includes('mapping')) return 'material_processing';
  if (lastStep.includes('cleanup')) return 'cleanup';
  
  // Analyze error message for additional context
  const errorMsg = error.message.toLowerCase();
  if (errorMsg.includes('layer') || errorMsg.includes('ocg')) return 'layer_processing';
  if (errorMsg.includes('naming') || errorMsg.includes('validation')) return 'naming_validation';
  if (errorMsg.includes('file') || errorMsg.includes('read')) return 'file_processing';
  if (errorMsg.includes('render') || errorMsg.includes('image')) return 'image_processing';
  
  return 'unknown';
}

// Enhanced cleanup with better error handling
async function cleanupTempFiles(jobDir) {
  try {
    const tempFiles = await fs.readdir(jobDir);
    let cleanedCount = 0;
    
    for (const file of tempFiles) {
      try {
        if (file.startsWith("temp_") || 
            file.endsWith(".tmp") || 
            file.includes("_full.png") ||
            file.includes("intermediate_")) {
          
          const filePath = path.join(jobDir, file);
          await fs.remove(filePath);
          cleanedCount++;
        }
      } catch (error) {
        console.warn(`⚠️ Failed to clean temp file ${file}:`, error.message);
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} temporary files`);
    }
    
  } catch (error) {
    console.warn("⚠️ Cleanup warning:", error.message);
  }
}

// Enhanced queue event handlers
parseQueue.on("error", (error) => {
  console.error("❌ Enhanced queue error:", error);
  setTimeout(() => {
    console.log("🔄 Attempting enhanced queue reconnection...");
    initializeQueue().catch(console.error);
  }, 5000);
});

parseQueue.on("waiting", (jobId) => {
  console.log(`⏳ Enhanced job waiting: ${jobId}`);
});

parseQueue.on("active", (job) => {
  console.log(`▶️ Enhanced job active: ${job.id} (${job.data?.originalName})`);
});

parseQueue.on("completed", (job, result) => {
  const processingTime = result.processingTime / 1000;
  const confidence = result.confidence * 100;
  const layerInfo = `${result.layersProcessed}/${result.layersFound}`;
  
  console.log(`✅ Enhanced job completed: ${job.id} in ${processingTime.toFixed(2)}s`);
  console.log(`   📊 Quality: ${(result.qualityScore.overall * 100).toFixed(1)}%, Confidence: ${confidence.toFixed(1)}%, Layers: ${layerInfo}`);
});

parseQueue.on("failed", (job, err) => {
  console.error(`❌ Enhanced job failed: ${job.id} - ${err.message}`);
});

parseQueue.on("progress", (job, progress) => {
  if (progress % 10 === 0 || progress > 90) {
    console.log(`📊 Enhanced job progress: ${job.id} - ${progress}%`);
  }
});

parseQueue.on("stalled", (job) => {
  console.warn(`⚠️ Enhanced job stalled: ${job.id} - will retry`);
});

parseQueue.on("resumed", () => {
  console.log("▶️ Enhanced queue resumed");
});

parseQueue.on("paused", () => {
  console.warn("⏸️ Enhanced queue paused");
});

// Redis connection monitoring
redis.on("close", () => {
  console.warn("🔴 Redis connection closed");
});

redis.on("reconnecting", () => {
  console.log("🔄 Redis reconnecting...");
});

redis.on("ready", () => {
  console.log("✅ Redis ready for enhanced processing");
});

// Enhanced graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`👋 ${signal} received, initiating enhanced graceful shutdown...`);
  let shutdownTimer;
  const forceShutdownAfter = 120000; // 2 minutes for enhanced processing

  try {
    shutdownTimer = setTimeout(() => {
      console.log("⏰ Force shutdown after timeout");
      process.exit(1);
    }, forceShutdownAfter);

    await parseQueue.pause();
    console.log("⏸️ Enhanced queue paused");

    const activeJobs = await parseQueue.getActive();
    if (activeJobs.length > 0) {
      console.log(`⏳ Waiting for ${activeJobs.length} enhanced jobs to complete...`);
      
      const checkInterval = setInterval(async () => {
        try {
          const stillActive = await parseQueue.getActive();
          if (stillActive.length === 0) {
            clearInterval(checkInterval);
            clearTimeout(shutdownTimer);
            await finalizeShutdown();
          } else {
            console.log(`⏳ Still waiting for ${stillActive.length} enhanced jobs...`);
          }
        } catch (error) {
          console.warn("Error checking active jobs:", error.message);
          clearInterval(checkInterval);
          clearTimeout(shutdownTimer);
          await finalizeShutdown();
        }
      }, 3000);
    } else {
      clearTimeout(shutdownTimer);
      await finalizeShutdown();
    }
  } catch (error) {
    console.error("Enhanced shutdown error:", error);
    process.exit(1);
  }
}

async function finalizeShutdown() {
  try {
    await closeQueue();
    console.log("✅ Enhanced worker shutdown complete");
    process.exit(0);
  } catch (error) {
    console.error("Enhanced final shutdown error:", error);
    process.exit(1);
  }
}

// Process signal handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  console.error("💥 Uncaught Exception in enhanced worker:", error);
  gracefulShutdown("UNCAUGHT_EXCEPTION");
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("💥 Unhandled Rejection in enhanced worker at:", promise, "reason:", reason);
  gracefulShutdown("UNHANDLED_REJECTION");
});

// Enhanced worker startup
async function startEnhancedWorker() {
  try {
    console.log("🚀 SilkCards Enhanced OCG Parser Worker starting...");
    console.log(`👷 Worker PID: ${process.pid}`);
    console.log(`⚙️ Concurrency: ${concurrency}`);
    console.log(`🔍 Queue: ${process.env.QUEUE_NAME || "parse_jobs"}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`🎨 Parser: Enhanced OCG v2.0`);

    await initializeQueue();

    console.log("✅ Enhanced Parser Worker ready and processing jobs!");
    console.log("📊 Monitoring enhanced queue for new jobs...");
    console.log("🎯 Features: Real OCG extraction, strict naming validation, enhanced quality metrics");

    // Enhanced monitoring with detailed stats
    setInterval(async () => {
      try {
        const waiting = await parseQueue.getWaiting();
        const active = await parseQueue.getActive();
        const completed = await parseQueue.getCompleted();
        const failed = await parseQueue.getFailed();
        
        if (waiting.length > 0 || active.length > 0) {
          console.log(`📊 Enhanced queue status: ${waiting.length} waiting, ${active.length} active, ${completed.length} completed, ${failed.length} failed`);
        }
        
        // Log memory usage periodically
        const memUsage = process.memoryUsage();
        const memUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        if (memUsedMB > 1000) { // Alert if using more than 1GB
          console.log(`⚠️ High memory usage: ${memUsedMB}MB`);
        }
        
      } catch (error) {
        console.warn("Enhanced health check failed:", error.message);
      }
    }, 30000);

    // Performance monitoring
    setInterval(() => {
      const uptime = process.uptime();
      const memUsage = process.memoryUsage();
      
      console.log(`🔍 Enhanced Worker Stats: Uptime: ${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m, Memory: ${Math.round(memUsage.heapUsed/1024/1024)}MB`);
    }, 300000); // Every 5 minutes
    
  } catch (error) {
    console.error("❌ Enhanced worker startup failed:", error);
    process.exit(1);
  }
}

// Start enhanced worker
startEnhancedWorker();

export { parseQueue, EnhancedOCGParser };