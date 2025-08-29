// src/scripts/health-check.js - Production Health Monitoring
import Redis from 'ioredis';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEALTH_LOG = '/var/log/parser/health.log';

async function performHealthCheck() {
  const timestamp = new Date().toISOString();
  const results = {
    timestamp,
    status: 'healthy',
    checks: {},
    issues: [],
    metrics: {}
  };

  try {
    // 1. Redis Connection Check
    console.log('Checking Redis connection...');
    const redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: process.env.REDIS_PORT || 6379,
      db: process.env.REDIS_DB || 0,
      connectTimeout: 5000,
      commandTimeout: 3000
    });

    try {
      const pong = await redis.ping();
      results.checks.redis = pong === 'PONG' ? 'healthy' : 'unhealthy';
      
      // Check queue status
      const queueKeys = await redis.keys('bull:parse_jobs:*');
      const isPaused = queueKeys.includes('bull:parse_jobs:paused');
      const waitingJobs = await redis.llen('bull:parse_jobs:waiting') || 0;
      const activeJobs = await redis.llen('bull:parse_jobs:active') || 0;
      
      results.metrics.queue = {
        paused: isPaused,
        waiting: waitingJobs,
        active: activeJobs,
        keys: queueKeys.length
      };
      
      // Critical: Resume queue if paused
      if (isPaused) {
        console.log('WARNING: Queue is paused, attempting to resume...');
        await redis.del('bull:parse_jobs:paused');
        await redis.del('bull:parse_jobs:meta-paused');
        results.issues.push('Queue was paused and has been resumed');
      }
      
    } finally {
      await redis.disconnect();
    }

    // 2. API Server Check
    console.log('Checking API server...');
    try {
      const response = await fetch('http://localhost:8000/health', {
        timeout: 5000
      });
      results.checks.api = response.ok ? 'healthy' : 'unhealthy';
      if (!response.ok) {
        results.issues.push(`API server returned ${response.status}`);
      }
    } catch (error) {
      results.checks.api = 'unhealthy';
      results.issues.push(`API server unreachable: ${error.message}`);
    }

    // 3. File System Check
    console.log('Checking file system...');
    const uploadDir = process.env.UPLOAD_DIR || '/opt/parser/uploads';
    const logDir = '/var/log/parser';
    
    try {
      await fs.access(uploadDir, fs.constants.W_OK);
      await fs.access(logDir, fs.constants.W_OK);
      results.checks.filesystem = 'healthy';
      
      // Check disk space
      const stats = await fs.stat(uploadDir);
      results.metrics.filesystem = {
        uploadDir: uploadDir,
        accessible: true
      };
    } catch (error) {
      results.checks.filesystem = 'unhealthy';
      results.issues.push(`File system issue: ${error.message}`);
    }

    // 4. Memory Check
    console.log('Checking system resources...');
    const memUsage = process.memoryUsage();
    const memUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const memTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    
    results.metrics.memory = {
      used: memUsedMB,
      total: memTotalMB,
      usage_percent: Math.round((memUsedMB / memTotalMB) * 100)
    };
    
    if (memUsedMB > 1500) { // Alert if using more than 1.5GB
      results.issues.push(`High memory usage: ${memUsedMB}MB`);
    }

    // 5. Process Check
    console.log('Checking processes...');
    try {
      const { execSync } = await import('child_process');
      
      // Check if worker and server processes are running
      const psOutput = execSync('ps aux | grep -E "(worker|server).js" | grep -v grep', 
        { encoding: 'utf8', timeout: 5000 });
      
      const processes = psOutput.trim().split('\n').filter(line => line.length > 0);
      const workerRunning = processes.some(line => line.includes('worker.js'));
      const serverRunning = processes.some(line => line.includes('server.js'));
      
      results.checks.worker = workerRunning ? 'healthy' : 'unhealthy';
      results.checks.server = serverRunning ? 'healthy' : 'unhealthy';
      
      if (!workerRunning) results.issues.push('Worker process not found');
      if (!serverRunning) results.issues.push('Server process not found');
      
      results.metrics.processes = {
        worker: workerRunning,
        server: serverRunning,
        count: processes.length
      };
      
    } catch (error) {
      results.issues.push(`Process check failed: ${error.message}`);
    }

    // Overall health determination
    const unhealthyChecks = Object.values(results.checks).filter(status => status === 'unhealthy');
    if (unhealthyChecks.length > 0 || results.issues.length > 0) {
      results.status = 'degraded';
    }
    
    if (unhealthyChecks.length > 2) {
      results.status = 'unhealthy';
    }

    // Log results
    const logEntry = {
      timestamp,
      status: results.status,
      checks: results.checks,
      issues: results.issues,
      metrics: results.metrics
    };

    console.log('Health Check Results:', JSON.stringify(logEntry, null, 2));

    // Write to health log
    try {
      await fs.ensureFile(HEALTH_LOG);
      await fs.appendFile(HEALTH_LOG, JSON.stringify(logEntry) + '\n');
    } catch (error) {
      console.error('Failed to write health log:', error);
    }

    // Exit with appropriate code
    if (results.status === 'unhealthy') {
      console.error('UNHEALTHY: Critical issues detected');
      process.exit(1);
    } else if (results.status === 'degraded') {
      console.warn('DEGRADED: Some issues detected but service operational');
      process.exit(0);
    } else {
      console.log('HEALTHY: All systems operational');
      process.exit(0);
    }

  } catch (error) {
    console.error('Health check failed:', error);
    
    const errorEntry = {
      timestamp,
      status: 'unhealthy',
      error: error.message,
      stack: error.stack
    };
    
    try {
      await fs.appendFile(HEALTH_LOG, JSON.stringify(errorEntry) + '\n');
    } catch (logError) {
      console.error('Failed to write error log:', logError);
    }
    
    process.exit(1);
  }
}

// Add timeout to prevent hanging
const healthTimeout = setTimeout(() => {
  console.error('Health check timed out');
  process.exit(1);
}, 30000);

performHealthCheck().finally(() => {
  clearTimeout(healthTimeout);
});