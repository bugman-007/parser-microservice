// src/worker.js - PRODUCTION VERSION WITH QUEUE RESUME FIX
import Queue from 'bull';
import Redis from 'ioredis';
import fs from 'fs-extra';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { AIParserV3 } from './services/parser.js';

// Load environment
dotenv.config();

// ES6 module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Redis connection with retry logic
const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  db: process.env.REDIS_DB || 0,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 5,
  retryDelayOnFailover: 1000,
  lazyConnect: true,
  connectTimeout: 10000,
  commandTimeout: 5000
};

const redis = new Redis(redisConfig);

// Parse queue with enhanced configuration
const parseQueue = new Queue(process.env.QUEUE_NAME || 'parse_jobs', {
  redis: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 5,
    attempts: parseInt(process.env.MAX_JOB_ATTEMPTS || '3'),
    backoff: {
      type: 'exponential',
      delay: parseInt(process.env.BACKOFF_DELAY_MS || '5000')
    },
    timeout: parseInt(process.env.JOB_TIMEOUT_MS || '300000')
  },
  settings: {
    stalledInterval: 30000,
    maxStalledCount: 1
  }
});

// Initialize parser
const parser = new AIParserV3({
  dpi: parseInt(process.env.DEFAULT_DPI || '600'),
  uploadDir: process.env.UPLOAD_DIR || '/opt/parser/uploads',
  enableOCG: process.env.ENABLE_OCG !== 'false',
  extractVector: process.env.EXTRACT_VECTOR !== 'false'
});

// Worker concurrency
const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '3');

console.log('🏭 Parser Worker Configuration:');
console.log(`  Concurrency: ${concurrency}`);
console.log(`  DPI: ${parser.dpi}`);
console.log(`  Upload Dir: ${parser.uploadDir}`);
console.log(`  OCG Enabled: ${parser.enableOCG}`);
console.log(`  Vector Extraction: ${parser.extractVector}`);
console.log(`  Redis: ${redisConfig.host}:${redisConfig.port}/${redisConfig.db}`);

// CRITICAL FIX: Resume queue and ensure it's ready for processing
async function initializeQueue() {
  try {
    console.log('🔧 Initializing queue system...');
    
    // Test Redis connection
    await redis.ping();
    console.log('✅ Redis connection established');
    
    // CRITICAL: Always resume queue on startup
    await parseQueue.resume();
    console.log('▶️ Queue resumed - ready for processing');
    
    // Clean up any stalled jobs
    // const stalledJobs = await parseQueue.getJobs(['stalled']);
    // if (stalledJobs.length > 0) {
      // console.log(`🔄 Found ${stalledJobs.length} stalled jobs, reprocessing...`);
      // for (const job of stalledJobs) {
        // await job.retry();
      // }
    // }
    
    // Clean up old completed jobs
    await parseQueue.clean(24 * 60 * 60 * 1000, 'completed', 10);
    await parseQueue.clean(24 * 60 * 60 * 1000, 'failed', 5);
    
    // Get queue status
    const waiting = await parseQueue.getWaiting();
    const active = await parseQueue.getActive();
    const completed = await parseQueue.getCompleted();
    const failed = await parseQueue.getFailed();
    
    console.log('📊 Queue Status:');
    console.log(`  Waiting: ${waiting.length}`);
    console.log(`  Active: ${active.length}`);
    console.log(`  Completed: ${completed.length}`);
    console.log(`  Failed: ${failed.length}`);
    
    return true;
  } catch (error) {
    console.error('❌ Queue initialization failed:', error);
    throw error;
  }
}

// Enhanced job processor with better error handling
parseQueue.process('parse', concurrency, async (job) => {
  const { jobId, filePath, originalName, fileSize, options, submittedAt } = job.data;
  
  console.log(`🔄 Processing job: ${jobId} (${originalName})`);
  console.log(`📊 File size: ${(fileSize / 1024 / 1024).toFixed(2)}MB`);
  
  const startTime = Date.now();
  let processingSteps = [];
  
  try {
    // Step 1: Validate file exists
    await job.progress(5);
    processingSteps.push({ step: 'validation', timestamp: Date.now() });
    
    if (!(await fs.pathExists(filePath))) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    const fileStats = await fs.stat(filePath);
    console.log(`📁 Processing file: ${originalName} (${(fileStats.size / 1024 / 1024).toFixed(2)}MB)`);
    
    // Step 2: Initialize job directory
    await job.progress(10);
    processingSteps.push({ step: 'initialization', timestamp: Date.now() });
    
    const jobDir = path.dirname(filePath);
    const assetsDir = path.join(jobDir, 'assets');
    await fs.ensureDir(assetsDir);
    
    // Step 3: Parse file with progress updates
    await job.progress(20);
    processingSteps.push({ step: 'parsing_start', timestamp: Date.now() });
    
    // Create progress updater
    const updateProgress = async (stage, baseProgress = 20) => {
      const progressMap = {
        'loading': 25,
        'ocg_extraction': 35,
        'layer_detection': 50,
        'texture_generation': 70,
        'material_mapping': 85,
        'finalizing': 95
      };
      
      const progress = progressMap[stage] || baseProgress;
      await job.progress(progress);
      console.log(`📈 Job ${jobId}: ${stage} (${progress}%)`);
    };
    
    // Parse with enhanced progress tracking
    const result = await parseWithProgressTracking(
      parser, 
      jobId, 
      filePath, 
      options, 
      updateProgress
    );
    
    await job.progress(90);
    processingSteps.push({ step: 'parsing_complete', timestamp: Date.now() });
    
    // Step 4: Post-processing and validation
    await job.progress(95);
    processingSteps.push({ step: 'post_processing', timestamp: Date.now() });
    
    // Validate result quality
    const qualityScore = await validateParseResult(result, assetsDir);
    result.quality = qualityScore;
    
    // Update manifest with processing details
    result.processing = {
      ...result.parsing,
      steps: processingSteps,
      totalTime: Date.now() - startTime,
      workerPid: process.pid,
      memoryUsage: process.memoryUsage(),
      completedAt: new Date().toISOString(),
      version: '1.1.0'
    };
    
    // Step 5: Save final result
    await job.progress(98);
    const resultPath = path.join(jobDir, 'result.json');
    await fs.writeJson(resultPath, result, { spaces: 2 });
    
    // Step 6: Cleanup temporary files
    await job.progress(100);
    processingSteps.push({ step: 'cleanup', timestamp: Date.now() });
    
    try {
      // Keep original file for debugging, clean up temp files only
      const tempFiles = await fs.readdir(jobDir);
      for (const file of tempFiles) {
        if (file.startsWith('temp_') || file.endsWith('.tmp')) {
          await fs.remove(path.join(jobDir, file));
        }
      }
      console.log('🧹 Cleaned up temporary files');
    } catch (cleanupError) {
      console.warn('⚠️ Cleanup warning:', cleanupError.message);
    }
    
    const totalTime = Date.now() - startTime;
    
    console.log(`✅ Job completed: ${jobId}`);
    console.log(`⏱️ Total time: ${(totalTime / 1000).toFixed(2)}s`);
    console.log(`🎯 Quality score: ${(qualityScore.overall * 100).toFixed(1)}%`);
    console.log(`📊 Assets generated: ${result.maps ? Object.keys(result.maps).length : 0}`);
    
    return {
      success: true,
      jobId,
      processingTime: totalTime,
      qualityScore,
      assetsGenerated: result.maps ? Object.keys(result.maps).length : 0,
      confidence: result.parsing?.confidence || 0.5
    };
    
  } catch (error) {
    const totalTime = Date.now() - startTime;
    
    console.error(`❌ Job failed: ${jobId}`, error);
    console.log(`⏱️ Failed after: ${(totalTime / 1000).toFixed(2)}s`);
    
    // Enhanced error details
    const errorDetails = {
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      processingSteps,
      processingTime: totalTime,
      jobId,
      originalName,
      fileSize,
      failedAt: new Date().toISOString(),
      workerPid: process.pid,
      memoryUsage: process.memoryUsage()
    };
    
    // Save error log
    try {
      const errorLogPath = path.join(path.dirname(filePath), 'error.json');
      await fs.writeJson(errorLogPath, errorDetails, { spaces: 2 });
    } catch (logError) {
      console.error('Failed to save error log:', logError);
    }
    
    throw error; // Re-throw for Bull to handle
  }
});

// Enhanced parser with detailed progress tracking
async function parseWithProgressTracking(parser, jobId, filePath, options, updateProgress) {
  await updateProgress('loading');
  
  try {
    const result = await parser.parseFile(jobId, filePath, options);
    await updateProgress('finalizing');
    return result;
  } catch (error) {
    console.error(`Parsing failed for ${jobId}:`, error.message);
    throw error;
  }
}

// Enhanced result validation
async function validateParseResult(result, assetsDir) {
  const quality = {
    overall: 0.5,
    dimensions: 0,
    layers: 0,
    assets: 0,
    effects: 0,
    files: 0
  };
  
  try {
    // Check dimensions validity
    if (result.dimensions && result.dimensions.width > 0 && result.dimensions.height > 0) {
      quality.dimensions = 1.0;
    }
    
    // Check layer extraction
    const layerCount = result.parsing?.layersFound || 0;
    quality.layers = Math.min(1.0, layerCount * 0.2);
    
    // Check asset generation and file existence
    if (result.maps) {
      const mapCount = Object.keys(result.maps).length;
      quality.assets = Math.min(1.0, mapCount * 0.25);
      
      // Verify asset files actually exist
      let existingAssets = 0;
      let totalExpectedAssets = 0;
      
      for (const [mapType, mapData] of Object.entries(result.maps)) {
        if (typeof mapData === 'string') {
          totalExpectedAssets++;
          const assetPath = path.join(assetsDir, mapData);
          if (await fs.pathExists(assetPath)) {
            existingAssets++;
          }
        } else if (Array.isArray(mapData)) {
          totalExpectedAssets += mapData.length;
          for (const item of mapData) {
            const fileName = item.mask || item.file || item.maskFile;
            if (fileName) {
              const assetPath = path.join(assetsDir, fileName);
              if (await fs.pathExists(assetPath)) {
                existingAssets++;
              }
            }
          }
        }
      }
      
      quality.files = totalExpectedAssets > 0 ? existingAssets / totalExpectedAssets : 0;
    }
    
    // Check effect detection
    const effectCount = result.parsing?.effectsExtracted || 0;
    quality.effects = Math.min(1.0, effectCount * 0.3);
    
    // Calculate overall quality (weighted average)
    const weights = {
      dimensions: 0.2,
      layers: 0.2,
      assets: 0.25,
      effects: 0.2,
      files: 0.15
    };
    
    quality.overall = Object.entries(weights).reduce((total, [key, weight]) => {
      return total + (quality[key] * weight);
    }, 0);
    
  } catch (error) {
    console.warn('Quality validation error:', error);
  }
  
  return quality;
}

// Enhanced event handlers
parseQueue.on('error', (error) => {
  console.error('❌ Queue error:', error);
  // Attempt to reconnect on queue errors
  setTimeout(() => {
    console.log('🔄 Attempting queue reconnection...');
    initializeQueue().catch(console.error);
  }, 5000);
});

parseQueue.on('waiting', (jobId) => {
  console.log(`⏳ Job waiting: ${jobId}`);
});

parseQueue.on('active', (job, jobPromise) => {
  console.log(`🔄 Job started: ${job.id} (${job.data.originalName})`);
});

parseQueue.on('completed', (job, result) => {
  console.log(`✅ Job completed: ${job.id} in ${(result.processingTime / 1000).toFixed(2)}s`);
});

parseQueue.on('failed', (job, err) => {
  console.error(`❌ Job failed: ${job.id} - ${err.message}`);
});

parseQueue.on('progress', (job, progress) => {
  if (progress % 10 === 0) { // Log every 10% to reduce noise
    console.log(`📊 Job progress: ${job.id} - ${progress}%`);
  }
});

parseQueue.on('stalled', (job) => {
  console.warn(`⚠️ Job stalled: ${job.id} - will retry`);
});

parseQueue.on('resumed', () => {
  console.log('▶️ Queue resumed');
});

parseQueue.on('paused', () => {
  console.warn('⏸️ Queue paused');
});

// Redis connection events
redis.on('connect', () => {
  console.log('🔴 Redis connected');
});

redis.on('ready', () => {
  console.log('✅ Redis ready');
});

redis.on('error', (error) => {
  console.error('❌ Redis error:', error.message);
});

redis.on('close', () => {
  console.warn('🔴 Redis connection closed');
});

redis.on('reconnecting', () => {
  console.log('🔄 Redis reconnecting...');
});

// Graceful shutdown with job completion waiting
async function gracefulShutdown(signal) {
  console.log(`👋 ${signal} received, initiating graceful shutdown...`);
  
  let shutdownTimer;
  const forceShutdownAfter = 60000; // Force shutdown after 1 minute
  
  try {
    // Start force shutdown timer
    shutdownTimer = setTimeout(() => {
      console.log('⏰ Force shutdown after timeout');
      process.exit(1);
    }, forceShutdownAfter);
    
    // Pause queue to prevent new jobs
    await parseQueue.pause();
    console.log('⏸️ Queue paused');
    
    // Wait for active jobs to complete
    const activeJobs = await parseQueue.getActive();
    if (activeJobs.length > 0) {
      console.log(`⏳ Waiting for ${activeJobs.length} active jobs to complete...`);
      
      const checkInterval = setInterval(async () => {
        const stillActive = await parseQueue.getActive();
        if (stillActive.length === 0) {
          clearInterval(checkInterval);
          clearTimeout(shutdownTimer);
          await finalizeShutdown();
        } else {
          console.log(`⏳ Still waiting for ${stillActive.length} jobs...`);
        }
      }, 2000);
    } else {
      clearTimeout(shutdownTimer);
      await finalizeShutdown();
    }
    
  } catch (error) {
    console.error('Shutdown error:', error);
    process.exit(1);
  }
}

async function finalizeShutdown() {
  try {
    // Close queue
    await parseQueue.close();
    console.log('🔴 Queue closed');
    
    // Close Redis connection
    await redis.disconnect();
    console.log('🔴 Redis disconnected');
    
    console.log('✅ Worker shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('Final shutdown error:', error);
    process.exit(1);
  }
}

// Process signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

// Worker startup
async function startWorker() {
  try {
    console.log('🚀 SilkCards Parser Worker starting...');
    console.log(`👷 Worker PID: ${process.pid}`);
    console.log(`⚙️ Concurrency: ${concurrency}`);
    console.log(`🔍 Queue: ${process.env.QUEUE_NAME || 'parse_jobs'}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    
    // Initialize queue system
    await initializeQueue();
    
    console.log('✅ Parser Worker ready and processing jobs!');
    console.log('📊 Monitoring queue for new jobs...');
    
    // Health check endpoint for monitoring
    setInterval(async () => {
      try {
        const waiting = await parseQueue.getWaiting();
        const active = await parseQueue.getActive();
        if (waiting.length > 0 || active.length > 0) {
          console.log(`📊 Queue status: ${waiting.length} waiting, ${active.length} active`);
        }
      } catch (error) {
        console.warn('Health check failed:', error.message);
      }
    }, 30000); // Every 30 seconds
    
  } catch (error) {
    console.error('❌ Worker startup failed:', error);
    process.exit(1);
  }
}

// Start the worker
startWorker();

export { parseQueue };
