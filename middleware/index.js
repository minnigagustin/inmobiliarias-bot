// middleware/index.js - Export all middleware
const auth = require("./auth");
const rateLimiter = require("./rateLimiter");
const validation = require("./validation");

module.exports = {
  // Auth
  requireAuth: auth.requireAuth,
  requireSuperAdmin: auth.requireSuperAdmin,
  wrap: auth.wrap,
  socketAuth: auth.socketAuth,
  socketSuperAdminAuth: auth.socketSuperAdminAuth,

  // Rate Limiting
  globalLimiter: rateLimiter.globalLimiter,
  loginLimiter: rateLimiter.loginLimiter,
  apiLimiter: rateLimiter.apiLimiter,

  // Validation
  loginValidation: validation.loginValidation,
  createAgentValidation: validation.createAgentValidation,
  updateAgentValidation: validation.updateAgentValidation,
  handleValidationErrors: validation.handleValidationErrors,
  handleLoginValidationErrors: validation.handleLoginValidationErrors,
};
