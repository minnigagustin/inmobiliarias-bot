// config/index.js - Centralized Configuration
require("dotenv").config();

const config = {
  // Server
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // Session
  sessionSecret: process.env.SESSION_SECRET,
  sessionMaxAge: 7 * 24 * 60 * 60 * 1000, // 7 days

  // Security
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map(s => s.trim())
    : ["http://localhost:3000", "https://backpackpuntaalta.ar"],

  // Rate Limiting
  rateLimits: {
    global: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100,
    },
    login: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 5,
    },
  },

  // WhatsApp Bridge
  bridgeUrl: process.env.BRIDGE_URL || "http://localhost:3000/bridge",
  agentNumber: process.env.AGENT_NUMBER || "",

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY,

  // WordPress
  wpBase: process.env.WP_BASE || "https://lginmobiliaria.com.ar",
  wpTimeout: parseInt(process.env.WP_TIMEOUT_MS, 10) || 9000,
  wpCacheTtl: parseInt(process.env.WP_CACHE_TTL_MS, 10) || 600000,

  // Branding
  companyName: process.env.COMPANY_NAME || "BR-Group",
  botName: process.env.BOT_NAME || "asistente virtual",

  // Media Cache
  mediaCacheMaxChats: 50,
  mediaCacheMaxPerChat: 10,
};

// Validation
function validateConfig() {
  const required = ['sessionSecret'];
  const missing = required.filter(key => !config[key]);

  if (missing.length > 0) {
    console.error(`\n❌ FATAL: Missing required environment variables: ${missing.join(', ')}`);
    console.error('   Create a .env file based on .env.example\n');

    if (missing.includes('sessionSecret')) {
      console.error('   Generate SESSION_SECRET with:');
      console.error('   node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n');
    }

    process.exit(1);
  }
}

module.exports = { config, validateConfig };
