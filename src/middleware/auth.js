// parser-microservice/src/middlewares/auth.js - AUTHENTICATION MIDDLEWARE
import crypto from 'crypto';

const API_KEY = process.env.API_KEY;
const HMAC_SECRET = process.env.HMAC_SECRET;

if (!API_KEY) {
  console.warn('⚠️ API_KEY not set - authentication disabled');
}

export const authenticateRequest = (req, res, next) => {
  // Skip authentication in development if no API key is set
  if (process.env.NODE_ENV === 'development' && !API_KEY) {
    console.log('🔓 Development mode - skipping authentication');
    return next();
  }

  if (!API_KEY) {
    return res.status(500).json({
      error: 'Server configuration error',
      message: 'Authentication not properly configured'
    });
  }

  const providedKey = req.headers['x-api-key'];
  const providedSignature = req.headers['x-signature'];

  // Check API key
  if (!providedKey || providedKey !== API_KEY) {
    console.warn('❌ Invalid API key from:', req.ip);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key'
    });
  }

  // For GET requests, API key is sufficient
  if (req.method === 'GET' || req.method === 'HEAD') {
    return next();
  }

  // For POST requests with file uploads, verify HMAC signature
  if (req.method === 'POST' && req.path === '/jobs') {
    // HMAC verification will be handled after multer processes the file
    // We'll validate it in the route handler where we have access to file data
    return next();
  }

  // For other POST requests, verify HMAC of JSON body
  if (req.method === 'POST' && HMAC_SECRET && providedSignature) {
    try {
      const bodyString = JSON.stringify(req.body);
      const timestamp = req.body.timestamp || req.headers['x-timestamp'];
      
      if (!timestamp) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing timestamp'
        });
      }

      // Check timestamp freshness (within 5 minutes)
      const timestampAge = Date.now() - parseInt(timestamp);
      if (timestampAge > 300000) { // 5 minutes
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Request timestamp too old'
        });
      }

      const expectedSignature = crypto
        .createHmac('sha256', HMAC_SECRET)
        .update(bodyString + timestamp)
        .digest('hex');

      if (providedSignature !== expectedSignature) {
        console.warn('❌ Invalid HMAC signature from:', req.ip);
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid signature'
        });
      }
    } catch (error) {
      console.error('HMAC verification error:', error);
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid request format'
      });
    }
  }

  next();
};

// Utility function to verify file upload HMAC
export const verifyFileUploadHMAC = (fileBuffer, options, timestamp, providedSignature) => {
  if (!HMAC_SECRET || !providedSignature) {
    return false;
  }

  try {
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const payload = `${fileHash}${JSON.stringify(options)}${timestamp}`;
    const expectedSignature = crypto
      .createHmac('sha256', HMAC_SECRET)
      .update(payload)
      .digest('hex');

    return providedSignature === expectedSignature;
  } catch (error) {
    console.error('File HMAC verification error:', error);
    return false;
  }
};