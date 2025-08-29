// parser-microservice/src/services/queue.js - QUEUE SERVICE
import Queue from 'bull';
import Redis from 'ioredis';

// Redis connection configuration
const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  db: process.env.REDIS_DB || 0,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  lazyConnect: true
};

console.log('🔴 Redis Configuration:', {
  host: redisConfig.host,
  port: redisConfig.port,
  db: redisConfig.db,
  hasPassword: !!redisConfig.password
});

// Create Redis instance
export const redis = new Redis(redisConfig);

// Create parse queue
export const parseQueue = new Queue(process.env.QUEUE_NAME || 'parse_jobs', {
  redis: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 5,
    attempts: parseInt(process.env.MAX_JOB_ATTEMPTS || '2'),
    backoff: {
      type: 'exponential',
      delay: parseInt(process.env.BACKOFF_DELAY_MS || '5000')
    }
  }
});

// Queue event handlers
parseQueue.on('error', (error) => {
  console.error('❌ Queue error:', error);
});

parseQueue.on('ready', () => {
  console.log('✅ Queue is ready');
});

parseQueue.on('waiting', (jobId) => {
  console.log(`⏳ Job waiting: ${jobId}`);
});

// Test Redis connection
redis.on('connect', () => {
  console.log('✅ Redis connected');
});

redis.on('error', (error) => {
  console.error('❌ Redis error:', error);
});

// Export for use in other modules
export default parseQueue;