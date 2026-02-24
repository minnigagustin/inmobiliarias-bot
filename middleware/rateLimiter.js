// middleware/rateLimiter.js - Rate Limiting Configuration
const rateLimit = require("express-rate-limit");
const { config } = require("../config");

/**
 * Global rate limiter (100 requests per 15 minutes)
 */
const globalLimiter = rateLimit({
  windowMs: config.rateLimits.global.windowMs,
  max: config.rateLimits.global.max,
  message: { error: "Demasiadas solicitudes, intenta de nuevo más tarde." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for static files and WebSocket
    return req.path.startsWith('/socket.io') || req.path.startsWith('/uploads') || req.path.startsWith('/css/') || req.path.startsWith('/widget/') || req.path.endsWith('.js') || req.path.endsWith('.css') || req.path.endsWith('.png') || req.path.endsWith('.ico');
  }
});

/**
 * Login rate limiter (5 attempts per 15 minutes)
 */
const loginLimiter = rateLimit({
  windowMs: config.rateLimits.login.windowMs,
  max: config.rateLimits.login.max,
  message: { error: "Demasiados intentos de login, intenta de nuevo en 15 minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * API rate limiter (more strict, 50 requests per 15 minutes)
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: "Demasiadas solicitudes API, intenta de nuevo más tarde." },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  globalLimiter,
  loginLimiter,
  apiLimiter,
};
