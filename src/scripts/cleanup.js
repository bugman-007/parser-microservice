// src/scripts/cleanup.js - Automated File and Queue Cleanup
import fs from 'fs-extra';
import path from 'path';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/opt/parser/uploads';
const TTL_DAYS = parseInt(process.env.TTL_DAYS || '30');
const LOG_FILE = '/var/log/parser/cleanup.log';

async function performCleanup() {
  const timestamp = new Date().toISOString();
  const results = {
    timestamp,
    filesProcessed: 0,
    filesDeleted: 0,
    bytesFreed: 0,
    queueCleaned: 0,
    errors: []
  };

  try {
    console.log(`Starting cleanup: TTL=${TTL_DAYS} days, Upload Dir=${UPLOAD_DIR}`);

    // 1. Clean up old files
    await cleanupFiles(results);

    // 2. Clean up Redis queue
    await cleanupQueue(results);

    // 3. Clean up logs
    await cleanupLogs(results);

    // Log results
    const summary = `Cleanup completed: ${results.filesDeleted}/${results.filesProcessed} files deleted, ${(results.bytesFreed / 1024 / 1024).toFixed(2)}MB freed`;
    console.log(summary);

    await logCleanupResults(results);

  } catch (error) {
    console.error('Cleanup failed:', error);
    results.errors.push(error.message);
    await logCleanupResults(results);
    process.exit(1);
  }
}

async function cleanupFiles(results) {
  console.log('Cleaning up old files...');
  
  if (!await fs.pathExists(UPLOAD_DIR)) {
    console.log('Upload directory does not exist, skipping file cleanup');
    return;
  }

  const cutoffTime = Date.now() - (TTL_DAYS * 24 * 60 * 60 * 1000);
  const entries = await fs.readdir(UPLOAD_DIR);

  for (const entry of entries) {
    try {
      const entryPath = path.join(UPLOAD_DIR, entry);
      const stats = await fs.stat(entryPath);
      
      results.filesProcessed++;

      // Check if older than TTL
      if (stats.mtime.getTime() < cutoffTime) {
        const size = await calculateDirectorySize(entryPath);
        
        await fs.remove(entryPath);
        results.filesDeleted++;
        results.bytesFreed += size;
        
        console.log(`Deleted: ${entry} (${(size / 1024 / 1024).toFixed(2)}MB)`);
      }
    } catch (error) {
      console.warn(`Error processing ${entry}:`, error.message);
      results.errors.push(`File cleanup error for ${entry}: ${error.message}`);
    }
  }
}

async function cleanupQueue(results) {
  console.log('Cleaning up Redis queue...');
  
  const redis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    db: process.env.REDIS_DB || 0,
    connectTimeout: 5000
  });

  try {
    // Clean up old completed and failed jobs
    const queueName = process.env.QUEUE_NAME || 'parse_jobs';
    const cleanupTime = 7 * 24 * 60 * 60 * 1000; // 7 days
    
    // Get all job keys
    const jobKeys = await redis.keys(`bull:${queueName}:*`);
    const currentTime = Date.now();
    
    for (const key of jobKeys) {
      try {
        // Skip meta keys and active job lists
        if (key.includes(':meta') || key.includes(':waiting') || key.includes(':active')) {
          continue;
        }
        
        // Check if it's a job ID key
        const keyParts = key.split(':');
        const lastPart = keyParts[keyParts.length - 1];
        
        // If it looks like a UUID (job ID), check its timestamp
        if (lastPart.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
          const jobData = await redis.hgetall(key);
          
          if (jobData.timestamp) {
            const jobAge = currentTime - parseInt(jobData.timestamp);
            
            if (jobAge > cleanupTime) {
              await redis.del(key);
              results.queueCleaned++;
              console.log(`Cleaned job: ${lastPart}`);
            }
          }
        }
      } catch (error) {
        console.warn(`Error cleaning queue key ${key}:`, error.message);
        results.errors.push(`Queue cleanup error for ${key}: ${error.message}`);
      }
    }
    
    // Clean up completed and failed job lists
    try {
      const completedKey = `bull:${queueName}:completed`;
      const failedKey = `bull:${queueName}:failed`;
      
      // Keep only the last 20 completed jobs
      const completedCount = await redis.llen(completedKey);
      if (completedCount > 20) {
        await redis.ltrim(completedKey, 0, 19);
        console.log(`Trimmed ${completedCount - 20} old completed job references`);
      }
      
      // Keep only the last 10 failed jobs
      const failedCount = await redis.llen(failedKey);
      if (failedCount > 10) {
        await redis.ltrim(failedKey, 0, 9);
        console.log(`Trimmed ${failedCount - 10} old failed job references`);
      }
    } catch (error) {
      console.warn('Error trimming job lists:', error.message);
    }

  } finally {
    await redis.disconnect();
  }
}

async function cleanupLogs(results) {
  console.log('Cleaning up old logs...');
  
  const logDir = '/var/log/parser';
  const logCutoffDays = 14; // Keep logs for 14 days
  const cutoffTime = Date.now() - (logCutoffDays * 24 * 60 * 60 * 1000);
  
  try {
    if (!await fs.pathExists(logDir)) {
      return;
    }
    
    const logFiles = await fs.readdir(logDir);
    
    for (const logFile of logFiles) {
      try {
        const logPath = path.join(logDir, logFile);
        const stats = await fs.stat(logPath);
        
        // Only clean up .log files, not current active logs
        if (logFile.endsWith('.log') && !logFile.includes(new Date().toISOString().split('T')[0])) {
          if (stats.mtime.getTime() < cutoffTime) {
            const size = stats.size;
            await fs.remove(logPath);
            results.bytesFreed += size;
            console.log(`Deleted log: ${logFile}`);
          }
        }
      } catch (error) {
        console.warn(`Error processing log ${logFile}:`, error.message);
      }
    }
  } catch (error) {
    console.warn('Log cleanup error:', error.message);
    results.errors.push(`Log cleanup error: ${error.message}`);
  }
}

async function calculateDirectorySize(dirPath) {
  let totalSize = 0;
  
  try {
    const stats = await fs.stat(dirPath);
    
    if (stats.isFile()) {
      return stats.size;
    }
    
    if (stats.isDirectory()) {
      const files = await fs.readdir(dirPath);
      
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        totalSize += await calculateDirectorySize(filePath);
      }
    }
  } catch (error) {
    console.warn(`Error calculating size for ${dirPath}:`, error.message);
  }
  
  return totalSize;
}

async function logCleanupResults(results) {
  try {
    await fs.ensureFile(LOG_FILE);
    await fs.appendFile(LOG_FILE, JSON.stringify(results) + '\n');
  } catch (error) {
    console.error('Failed to write cleanup log:', error);
  }
}

// Timeout protection
const cleanupTimeout = setTimeout(() => {
  console.error('Cleanup timed out after 10 minutes');
  process.exit(1);
}, 10 * 60 * 1000);

performCleanup().finally(() => {
  clearTimeout(cleanupTimeout);
});