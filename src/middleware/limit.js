// parser-microservice/src/middlewares/limits.js - RATE LIMITING MIDDLEWARE
const requestCounts = new Map();
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'); // 15 minutes
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100');

export const rateLimitMiddleware = (req, res, next) => {
  // Skip rate limiting in development
  if (process.env.NODE_ENV === 'development') {
    return next();
  }

  const clientIP = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // Clean up old entries
  const clientRequests = requestCounts.get(clientIP) || [];
  const validRequests = clientRequests.filter(timestamp => timestamp > windowStart);

  // Check if over limit
  if (validRequests.length >= MAX_REQUESTS) {
    console.warn(`🚫 Rate limit exceeded for IP: ${clientIP}`);
    return res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Maximum ${MAX_REQUESTS} requests per ${WINDOW_MS / 1000 / 60} minutes.`,
      retryAfter: Math.ceil(WINDOW_MS / 1000),
      code: 'RATE_LIMIT_EXCEEDED'
    });
  }

  // Add current request
  validRequests.push(now);
  requestCounts.set(clientIP, validRequests);

  // Add headers
  res.set({
    'X-RateLimit-Limit': MAX_REQUESTS,
    'X-RateLimit-Remaining': Math.max(0, MAX_REQUESTS - validRequests.length),
    'X-RateLimit-Reset': new Date(now + WINDOW_MS).toISOString()
  });

  next();
};

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  
  for (const [clientIP, requests] of requestCounts.entries()) {
    const validRequests = requests.filter(timestamp => timestamp > windowStart);
    if (validRequests.length === 0) {
      requestCounts.delete(clientIP);
    } else {
      requestCounts.set(clientIP, validRequests);
    }
  }
}, WINDOW_MS); // Clean up every window period