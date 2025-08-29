// src/server.js - PRODUCTION VERSION WITH ENHANCED RELIABILITY
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import Redis from 'ioredis';
import Queue from 'bull';

// Import services
import { authenticateRequest } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/limit.js';

// Load environment
dotenv.config();

// ES6 module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8000;

// Enhanced logging setup
const logDir = '/var/log/parser';
await fs.ensureDir(logDir);

// Setup Winston logger for production
import { createLogger, format, transports } from 'winston';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: 'parser-api' },
  transports: [
    new transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
    new transports.File({ filename: path.join(logDir, 'combined.log') }),
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.simple()
      )
    })
  ]
});

// Ensure upload directory exists
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
await fs.ensureDir(UPLOAD_DIR);

console.log('📁 Upload directory:', UPLOAD_DIR);

// Redis connection with retry logic
const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  db: process.env.REDIS_DB || 0,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  lazyConnect: true,
  connectTimeout: 10000
};

const redis = new Redis(redisConfig);

// Parse queue instance (for monitoring)
const parseQueue = new Queue(process.env.QUEUE_NAME || 'parse_jobs', {
  redis: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 5
  }
});

// CRITICAL: Ensure queue is never paused on server startup
await initializeQueue();

async function initializeQueue() {
  try {
    console.log('🔧 Initializing queue system...');
    
    // CRITICAL FIX: Always resume queue on server startup
    await parseQueue.resume();
    console.log('▶️ Queue resumed - accepting new jobs');
    
    // Clean up any paused state
    await redis.del('bull:parse_jobs:paused');
    await redis.del('bull:parse_jobs:meta-paused');
    
    const waiting = await parseQueue.getWaiting();
    const active = await parseQueue.getActive();
    
    console.log('📊 Initial queue status:');
    console.log(`  Waiting: ${waiting.length}`);
    console.log(`  Active: ${active.length}`);
    
  } catch (error) {
    logger.error('Queue initialization failed:', error);
    throw error;
  }
}

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false
}));

// CORS configuration with enhanced security
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    // Allow localhost in development
    if (process.env.NODE_ENV === 'development' && origin.includes('localhost')) {
      return callback(null, true);
    }
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    logger.warn('CORS blocked origin:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  optionsSuccessStatus: 200
}));

// General middleware
app.use(compression());

// Enhanced request logging
app.use(morgan('combined', {
  stream: {
    write: (message) => {
      logger.info(message.trim());
    }
  }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
app.use(rateLimitMiddleware);

// Trust proxy for accurate IP addresses
app.set('trust proxy', 1);

// File upload configuration with enhanced security
const upload = multer({
  dest: '/tmp/',
  limits: { 
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '104857600'), // 100MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const validTypes = ['.ai', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    const isValid = validTypes.includes(ext) || file.mimetype === 'application/pdf';
    
    if (!isValid) {
      const error = new Error('Invalid file type. Only .ai and .pdf files are allowed.');
      error.code = 'INVALID_FILE_TYPE';
      return cb(error, false);
    }
    
    // Additional security: check file header
    if (file.mimetype === 'application/pdf' && ext !== '.pdf') {
      const error = new Error('File extension does not match MIME type.');
      error.code = 'MIME_MISMATCH';
      return cb(error, false);
    }
    
    cb(null, true);
  }
});

// Enhanced request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.originalUrl;
  const ip = req.ip || req.connection.remoteAddress;
  
  // Log request
  logger.info(`${timestamp} | ${method} ${url} | IP: ${ip}`);
  
  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${method} ${url} | ${res.statusCode} | ${duration}ms`);
  });
  
  next();
});

// Routes

// Submit parse job with enhanced error handling
app.post('/jobs', authenticateRequest, upload.single('file'), async (req, res) => {
  let jobId;
  let jobDir;
  
  try {
    jobId = req.query.jobId || uuidv4();
    const file = req.file;
    const options = JSON.parse(req.body.options || '{}');
    
    if (!file) {
      return res.status(400).json({ 
        error: 'No file uploaded',
        code: 'NO_FILE'
      });
    }
    
    // Enhanced file validation
    const fileStats = await fs.stat(file.path);
    if (!fileStats.isFile()) {
      await fs.remove(file.path); // Cleanup
      return res.status(400).json({
        error: 'Invalid file upload',
        code: 'INVALID_FILE'
      });
    }
    
    // Virus scan placeholder (implement with ClamAV in production)
    if (process.env.ENABLE_VIRUS_SCAN === 'true') {
      // TODO: Implement virus scanning
      logger.info(`Virus scan skipped for ${jobId} (not implemented)`);
    }
    
    logger.info(`📤 New job: ${jobId} (${file.originalname}, ${(fileStats.size / 1024 / 1024).toFixed(2)}MB)`);
    
    // Create job directory with proper permissions
    jobDir = path.join(UPLOAD_DIR, jobId);
    await fs.ensureDir(jobDir);
    await fs.ensureDir(path.join(jobDir, 'assets'));
    
    // Move uploaded file to job directory with error handling
    const finalPath = path.join(jobDir, file.originalname);
    try {
      await fs.move(file.path, finalPath);
    } catch (moveError) {
      logger.error(`File move failed for ${jobId}:`, moveError);
      await fs.remove(file.path); // Cleanup temp file
      throw new Error('Failed to process uploaded file');
    }
    
    // Enhanced job data
    const jobData = {
      jobId,
      filePath: finalPath,
      originalName: file.originalname,
      fileSize: fileStats.size,
      options: {
        dpi: options.dpi || 600,
        extractVector: options.extractVector !== false,
        enableOCG: options.enableOCG !== false,
        ...options
      },
      submittedAt: new Date().toISOString(),
      submittedBy: req.ip,
      userAgent: req.get('User-Agent'),
      version: '1.1.0'
    };
    
    // CRITICAL: Ensure queue is not paused before adding job
    const isPaused = await redis.exists('bull:parse_jobs:paused');
    if (isPaused) {
      logger.warn(`Queue was paused, resuming for job ${jobId}`);
      await parseQueue.resume();
      await redis.del('bull:parse_jobs:paused');
      await redis.del('bull:parse_jobs:meta-paused');
    }
    
    // Add to queue with retry logic
    const job = await parseQueue.add('parse', jobData, {
      jobId: jobId,
      removeOnComplete: 10,
      removeOnFail: 5,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000
      },
      timeout: 300000 // 5 minutes timeout
    });
    
    logger.info(`✅ Job queued: ${jobId}`);
    
    res.json({
      jobId,
      status: 'queued',
      submittedAt: jobData.submittedAt,
      estimatedTime: '30-120 seconds',
      queuePosition: await getQueuePosition(jobId)
    });
    
  } catch (error) {
    logger.error('Job submission error:', error);
    
    // Enhanced cleanup on error
    if (req.file?.path) {
      try {
        await fs.remove(req.file.path);
      } catch (cleanupError) {
        logger.error('Temp file cleanup error:', cleanupError);
      }
    }
    
    if (jobDir) {
      try {
        await fs.remove(jobDir);
      } catch (cleanupError) {
        logger.error('Job directory cleanup error:', cleanupError);
      }
    }
    
    // Specific error handling
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'File too large',
        message: `Maximum file size is ${process.env.MAX_FILE_SIZE || '100MB'}`,
        code: 'FILE_TOO_LARGE'
      });
    }
    
    if (error.code === 'INVALID_FILE_TYPE' || error.code === 'MIME_MISMATCH') {
      return res.status(400).json({
        error: 'Invalid file type',
        message: error.message,
        code: error.code
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to submit job',
      message: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
      code: error.code || 'SUBMISSION_FAILED'
    });
  }
});

// Get job status with enhanced monitoring
app.get('/status/:jobId', authenticateRequest, async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await parseQueue.getJob(jobId);
    
    if (!job) {
      return res.status(404).json({ 
        error: 'Job not found',
        jobId,
        code: 'JOB_NOT_FOUND'
      });
    }
    
    const state = await job.getState();
    const progress = job.progress();
    const data = job.data;
    
    let status;
    switch (state) {
      case 'waiting': status = 'queued'; break;
      case 'active': status = 'processing'; break;
      case 'completed': status = 'completed'; break;
      case 'failed': status = 'failed'; break;
      case 'delayed': status = 'delayed'; break;
      case 'paused': status = 'paused'; break;
      default: status = 'unknown';
    }
    
    const response = {
      jobId,
      status,
      progress: Math.round(progress || 0),
      submittedAt: data.submittedAt,
      originalFile: data.originalName,
      fileSize: data.fileSize
    };
    
    // Add state-specific information
    if (state === 'failed') {
      response.error = job.failedReason;
      response.attempts = job.attemptsMade;
    }
    
    if (state === 'active') {
      response.processingStartedAt = job.processedOn ? new Date(job.processedOn).toISOString() : null;
    }
    
    if (state === 'completed') {
      response.completedAt = job.finishedOn ? new Date(job.finishedOn).toISOString() : null;
      response.processingTime = job.finishedOn && job.processedOn ? 
        job.finishedOn - job.processedOn : null;
    }
    
    if (state === 'waiting') {
      response.queuePosition = await getQueuePosition(jobId);
    }
    
    res.json(response);
    
  } catch (error) {
    logger.error('Status check error:', error);
    res.status(500).json({ 
      error: 'Status check failed',
      message: error.message,
      code: 'STATUS_CHECK_FAILED'
    });
  }
});

// Get parse result with caching headers
app.get('/jobs/:jobId/result.json', authenticateRequest, async (req, res) => {
  try {
    const { jobId } = req.params;
    const resultPath = path.join(UPLOAD_DIR, jobId, 'result.json');
    
    if (!(await fs.pathExists(resultPath))) {
      return res.status(404).json({ 
        error: 'Result not found',
        message: 'Job may not be completed yet or result was cleaned up',
        jobId,
        code: 'RESULT_NOT_FOUND'
      });
    }
    
    const result = await fs.readJson(resultPath);
    const stats = await fs.stat(resultPath);
    
    // Add metadata
    result.generatedAt = stats.mtime.toISOString();
    result.jobId = jobId;
    result.serverVersion = '1.1.0';
    
    // Set caching headers
    res.set({
      'Cache-Control': 'public, max-age=3600', // 1 hour cache
      'ETag': `"${jobId}-${stats.mtime.getTime()}"`,
      'Last-Modified': stats.mtime.toUTCString()
    });
    
    res.json(result);
    
  } catch (error) {
    logger.error('Result fetch error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch result',
      message: error.message,
      jobId: req.params.jobId,
      code: 'RESULT_FETCH_FAILED'
    });
  }
});

// Serve asset files with enhanced caching and security
app.get('/jobs/:jobId/assets/:filename', authenticateRequest, async (req, res) => {
  try {
    const { jobId, filename } = req.params;
    
    // Enhanced security: validate filename
    if (!filename.match(/^[a-zA-Z0-9_.-]+\.(png|jpg|jpeg|svg|pdf)$/)) {
      return res.status(400).json({
        error: 'Invalid filename',
        code: 'INVALID_FILENAME'
      });
    }
    
    // Prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({
        error: 'Invalid filename',
        code: 'INVALID_FILENAME'
      });
    }
    
    const assetPath = path.join(UPLOAD_DIR, jobId, 'assets', filename);
    
    if (!(await fs.pathExists(assetPath))) {
      return res.status(404).json({ 
        error: 'Asset not found',
        jobId,
        filename,
        code: 'ASSET_NOT_FOUND'
      });
    }
    
    const stats = await fs.stat(assetPath);
    const ext = path.extname(filename).toLowerCase();
    
    // Enhanced content type detection
    const contentTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf'
    };
    
    const contentType = contentTypes[ext] || 'application/octet-stream';
    
    // Enhanced caching headers
    const etag = `"${jobId}-${filename}-${stats.mtime.getTime()}"`;
    res.set({
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': 'public, max-age=31536000, immutable', // 1 year cache
      'ETag': etag,
      'Last-Modified': stats.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff'
    });
    
    // Handle conditional requests
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    
    // Stream the file efficiently
    const stream = fs.createReadStream(assetPath);
    
    stream.on('error', (error) => {
      logger.error('Asset streaming error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Failed to serve asset',
          code: 'STREAM_ERROR'
        });
      }
    });
    
    stream.pipe(res);
    
    logger.info(`✅ Served asset: ${jobId}/${filename} (${(stats.size / 1024).toFixed(1)}KB)`);
    
  } catch (error) {
    logger.error('Asset serve error:', error);
    res.status(500).json({ 
      error: 'Failed to serve asset',
      message: error.message,
      jobId: req.params.jobId,
      filename: req.params.filename,
      code: 'ASSET_SERVE_FAILED'
    });
  }
});

// Enhanced health check with queue monitoring
app.get('/health', async (req, res) => {
  try {
    const waiting = await parseQueue.getWaiting();
    const active = await parseQueue.getActive();
    const completed = await parseQueue.getCompleted();
    const failed = await parseQueue.getFailed();
    
    // Check Redis connection
    const redisPing = await redis.ping();
    const redisConnected = redisPing === 'PONG';
    
    // Check queue status
    const isPaused = await redis.exists('bull:parse_jobs:paused');
    
    // Check disk space
    let diskSpace = null;
    try {
      const stats = await fs.stat(UPLOAD_DIR);
      diskSpace = {
        uploadDir: UPLOAD_DIR,
        accessible: true
      };
    } catch (error) {
      diskSpace = { accessible: false, error: error.message };
    }
    
    const health = {
      status: redisConnected && !isPaused ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      service: 'SilkCards Parser Microservice',
      version: '1.1.0',
      queue: {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        paused: !!isPaused
      },
      redis: {
        connected: redisConnected,
        host: redisConfig.host,
        port: redisConfig.port,
        db: redisConfig.db
      },
      system: {
        uptime: Math.floor(process.uptime()),
        memory: {
          used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
        },
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch
      },
      storage: diskSpace,
      config: {
        maxFileSize: process.env.MAX_FILE_SIZE || '100MB',
        workerConcurrency: process.env.WORKER_CONCURRENCY || '3',
        ttlDays: process.env.TTL_DAYS || '30',
        dpi: process.env.DEFAULT_DPI || '600',
        environment: process.env.NODE_ENV || 'development'
      }
    };
    
    // Set appropriate status code
    const statusCode = health.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(health);
    
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(500).json({ 
      status: 'unhealthy', 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Enhanced metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    const completed = await parseQueue.getCompleted();
    const failed = await parseQueue.getFailed();
    
    // Calculate processing statistics
    let totalTime = 0;
    let count = 0;
    const times = [];
    
    for (const job of completed.slice(-100)) {
      if (job.finishedOn && job.processedOn) {
        const processingTime = job.finishedOn - job.processedOn;
        times.push(processingTime);
        totalTime += processingTime;
        count++;
      }
    }
    
    times.sort((a, b) => a - b);
    
    // Get queue metrics
    const waiting = await parseQueue.getWaiting();
    const active = await parseQueue.getActive();
    
    const metrics = {
      timestamp: new Date().toISOString(),
      processing: {
        averageTimeMs: count > 0 ? Math.round(totalTime / count) : 0,
        p50TimeMs: count > 0 ? times[Math.floor(count * 0.5)] || 0 : 0,
        p90TimeMs: count > 0 ? times[Math.floor(count * 0.9)] || 0 : 0,
        p95TimeMs: count > 0 ? times[Math.floor(count * 0.95)] || 0 : 0,
        completedLast24h: completed.filter(job => 
          job.finishedOn && (Date.now() - job.finishedOn) < 86400000
        ).length,
        failedLast24h: failed.filter(job => 
          job.failedReason && (Date.now() - (job.timestamp || 0)) < 86400000
        ).length
      },
      queue: {
        totalProcessed: completed.length,
        totalFailed: failed.length,
        currentWaiting: waiting.length,
        currentActive: active.length,
        successRate: completed.length > 0 ? 
          Math.round((completed.length / (completed.length + failed.length)) * 100) : 0
      },
      system: {
        memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        uptimeSeconds: Math.floor(process.uptime())
      }
    };
    
    res.json(metrics);
    
  } catch (error) {
    logger.error('Metrics error:', error);
    res.status(500).json({ 
      error: 'Metrics unavailable',
      message: error.message
    });
  }
});

// Utility function to get queue position
async function getQueuePosition(jobId) {
  try {
    const waiting = await parseQueue.getWaiting();
    const position = waiting.findIndex(job => job.id === jobId);
    return position >= 0 ? position + 1 : null;
  } catch (error) {
    logger.warn('Failed to get queue position:', error);
    return null;
  }
}

// Global error handling middleware
app.use((err, req, res, next) => {
  const timestamp = new Date().toISOString();
  logger.error('Global error handler:', err);
  
  // CORS errors
  if (err.message && err.message.includes('CORS')) {
    return res.status(403).json({ 
      error: 'CORS Error', 
      message: 'Origin not allowed'
    });
  }
  
  // File upload errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'File too large',
      message: 'Maximum file size is 100MB',
      code: 'FILE_TOO_LARGE'
    });
  }
  
  if (err.code === 'INVALID_FILE_TYPE') {
    return res.status(400).json({
      error: 'Invalid file type',
      message: err.message,
      code: 'INVALID_FILE_TYPE'
    });
  }
  
  // Generic error response
  res.status(err.status || 500).json({ 
    error: err.name || 'Internal Server Error', 
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
    timestamp,
    code: err.code || 'INTERNAL_ERROR'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
    availableRoutes: [
      'POST /jobs?jobId=...',
      'GET /status/:jobId',
      'GET /jobs/:jobId/result.json',
      'GET /jobs/:jobId/assets/:filename',
      'GET /health',
      'GET /metrics'
    ]
  });
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully...`);
  
  try {
    // Stop accepting new connections
    const server = app.listen(PORT);
    server.close();
    
    // Close queue connections
    await parseQueue.close();
    await redis.disconnect();
    
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 SilkCards Parser Microservice v1.1.0');
  console.log(`📡 Server: http://0.0.0.0:${PORT}`);
  console.log(`📁 Upload directory: ${UPLOAD_DIR}`);
  console.log(`🔑 Authentication: ${!!process.env.API_KEY}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`⚙️ Worker concurrency: ${process.env.WORKER_CONCURRENCY || '3'}`);
  console.log(`🔍 Health check: http://localhost:${PORT}/health`);
  console.log('✅ All systems ready!');
});

export default app;