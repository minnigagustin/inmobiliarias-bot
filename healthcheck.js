// healthcheck.js - Health Check Endpoint Module
const qrStore = require("./wa-qr-store");

/**
 * Health check data
 */
function getHealthStatus() {
  const waStatus = qrStore.get();
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();

  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(uptime),
    uptimeHuman: formatUptime(uptime),
    memory: {
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + " MB",
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + " MB",
      rss: Math.round(memoryUsage.rss / 1024 / 1024) + " MB",
    },
    whatsapp: {
      status: waStatus.status || "unknown",
      ready: waStatus.ready || false,
      lastUpdate: waStatus.ts ? new Date(waStatus.ts).toISOString() : null,
    },
    node: {
      version: process.version,
      platform: process.platform,
      pid: process.pid,
    },
  };
}

/**
 * Format uptime to human readable string
 */
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);

  return parts.join(" ");
}

/**
 * Express route handler for health check
 */
function healthRoute(req, res) {
  const health = getHealthStatus();

  // Determine HTTP status code based on WhatsApp status
  const httpStatus = health.whatsapp.ready ? 200 : 503;

  res.status(httpStatus).json(health);
}

/**
 * Simple liveness probe (always returns 200)
 */
function livenessRoute(req, res) {
  res.status(200).json({ status: "alive", timestamp: new Date().toISOString() });
}

/**
 * Readiness probe (checks if WhatsApp is connected)
 */
function readinessRoute(req, res) {
  const waStatus = qrStore.get();
  const ready = waStatus.ready || false;

  if (ready) {
    res.status(200).json({ status: "ready", whatsapp: "connected" });
  } else {
    res.status(503).json({ status: "not_ready", whatsapp: waStatus.status || "disconnected" });
  }
}

module.exports = {
  getHealthStatus,
  healthRoute,
  livenessRoute,
  readinessRoute,
};
