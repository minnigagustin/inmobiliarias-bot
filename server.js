// server.js — Web chat + botones + Panel Admin + Base de Datos + Login + Super Admin
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const qrStore = require("./wa-qr-store");

// 🔥 MÓDULOS DE PERSISTENCIA Y SEGURIDAD
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const DB = require("./database");

// 🛡️ MÓDULOS DE SEGURIDAD (Fase 2)
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { body, validationResult } = require("express-validator");
const compression = require("compression");

require("dotenv").config();

// 🛡️ Verificar SESSION_SECRET obligatorio
if (!process.env.SESSION_SECRET) {
  console.error("❌ FATAL: SESSION_SECRET no está definido en .env");
  console.error(
    "   Genera uno con: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
  process.exit(1);
}

// 🛡️ Configuración de CORS origins permitidos
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
  : ["http://localhost:3000", "https://backpackpuntaalta.ar"];

// 👇 Importa helpers IA adicionales desde engine.js
const {
  handleText,
  handleImage,
  reset,
  getSession,
  engineExitAI,
  engineTouchAI,
} = require("./engine");

/* ====================== Botones contextuales ====================== */
function buildButtonsForStep(session) {
  const step = session?.step;
  if (!step) return null;

  switch (step) {
    case "main":
      return [
        { label: "1. Administración de alquileres", value: "1" },
        { label: "2. Consulta de propiedades", value: "2" },
        { label: "3. Consultas generales", value: "3" },
      ];
    case "alquileres_menu":
      return [
        { label: "1. Reportar un problema", value: "1" },
        { label: "2. Actualizar por índice", value: "2" },
        { label: "3. Info inquilinos", value: "3" },
        { label: "4. Info propietarios", value: "4" },
        { label: "5. Hablar con un operador", value: "5" },
      ];
    case "rep_categoria":
      return [
        { label: "1. Plomería", value: "1" },
        { label: "2. Gas", value: "2" },
        { label: "3. Electricidad", value: "3" },
        { label: "4. Artefacto roto", value: "4" },
        { label: "5. Otro", value: "5" },
      ];
    case "indices_menu":
      return [
        { label: "ICL", value: "ICL" },
        { label: "CAC", value: "CAC" },
        { label: "UVA", value: "UVA" },
        { label: "UVI", value: "UVI" },
        { label: "CER", value: "CER" },
        { label: "Casa Propia", value: "Casa Propia" },
        { label: "IPC INDEC 1 mes", value: "IPC INDEC 1" },
        { label: "IPC INDEC 2 meses", value: "IPC INDEC 2" },
        { label: "IPC CREEBBA 1 mes", value: "IPC CREEBBA 1" },
        { label: "IPC CREEBBA 2 meses", value: "IPC CREEBBA 2" },
      ];
    case "rep_derivar":
    case "ind_derivar":
    case "prop_buscar_derivar":
    case "prop_cochera":
      return [
        { label: "Sí", value: "sí" },
        { label: "No", value: "no" },
      ];
    case "prop_vender_derivar":
      return [
        { label: "Sí", value: "sí" },
        { label: "No", value: "no" },
      ];
    case "rep_fotos_preg":
      return [
        { label: "Sí", value: "sí" },
        { label: "No", value: "no" },
      ];
    case "prop_menu":
      return [
        { label: "1. Alquilar", value: "1" },
        { label: "2. Comprar", value: "2" },
        { label: "3. Temporario", value: "3" },
        { label: "4. Vender", value: "4" },
      ];
    case "prop_tipo_menu":
      return [
        { label: "1. Casa", value: "1" },
        { label: "2. Depto", value: "2" },
        { label: "3. PH", value: "3" },
        { label: "4. Otro", value: "4" },
      ];
    case "ind_moneda":
    case "prop_moneda":
      return [
        { label: "1. Pesos (ARS)", value: "1" },
        { label: "2. Dólares (USD)", value: "2" },
      ];
    case "prop_ciudad": {
      const opts = session?.data?.cityOptions || [];
      const top = opts.slice(0, 10);
      return top.map((c, i) => ({
        label: `${i + 1}. ${c.name}`,
        value: String(i + 1),
      }));
    }
    default:
      return null;
  }
}

/* ====================== Cola + handoff + transcript ====================== */
const pendingChats = new Map();
const conversations = new Map();
const humanChats = new Map();
const aiTimers = new Map();
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos

function addToQueue(rec, adminIo) {
  pendingChats.set(rec.chatId, rec);
  adminIo.emit("queue_add", rec);
}
function removeFromQueue(chatId, adminIo) {
  if (pendingChats.delete(chatId)) adminIo.emit("queue_remove", { chatId });
}

// 🔥 GUARDADO EN DB
function pushTranscript(chatId, msg) {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  conversations.get(chatId).push(msg);
  DB.saveMessage(chatId, msg);
}

// ==== Helpers IA proactivo (server) ====
function clearAIModeTimer(chatId) {
  const t = aiTimers.get(chatId);
  if (t) {
    clearTimeout(t);
    aiTimers.delete(chatId);
  }
}

function scheduleAIModeTimeout(chatId, untilTs) {
  clearAIModeTimer(chatId);
  const delay = Math.max(0, untilTs - Date.now());
  const t = setTimeout(() => {
    if (humanChats.has(chatId)) return clearAIModeTimer(chatId);
    const s = getSession(chatId);
    const stillAI = s && s.step === "consultas_ia" && s.data?.ai?.active;
    if (!stillAI) return clearAIModeTimer(chatId);

    engineExitAI(chatId);
    const text =
      "⏱️ Cerramos el modo consulta por inactividad. Escribí *menu* para volver.";
    io.to(chatId).emit("system_message", { text });
    pushTranscript(chatId, {
      who: "system",
      text,
      ts: Date.now(),
      type: "text",
    });
    clearAIModeTimer(chatId);
  }, delay);
  aiTimers.set(chatId, t);
}

/* ====================== INICIO DEL SERVER ====================== */
const app = express();
const server = http.createServer(app);

/// 🛡️ SEGURIDAD: Helmet para headers de seguridad
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://api.fontshare.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "wss:", "ws:"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.fontshare.com"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

// 🛡️ SEGURIDAD: Compresión
app.use(compression());

// 🛡️ SEGURIDAD: Rate Limiter Global (100 requests per 15 min)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  message: { error: "Demasiadas solicitudes, intenta de nuevo más tarde." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for static files and WebSocket
    return req.path.startsWith("/socket.io") || req.path.startsWith("/uploads") || req.path.startsWith("/css/") || req.path.startsWith("/widget/") || req.path.endsWith(".js") || req.path.endsWith(".css") || req.path.endsWith(".png") || req.path.endsWith(".ico");
  },
});
app.use(globalLimiter);

// 🛡️ SEGURIDAD: Rate Limiter para Login (5 requests per 15 min)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5,
  message: {
    error: "Demasiados intentos de login, intenta de nuevo en 15 minutos.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({ limit: "10mb" }));

app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// 2. Configuración de Sesiones (Segura)
const isProduction = process.env.NODE_ENV === "production";
const sessionMiddleware = session({
  store: new SQLiteStore({ db: "sessions.db", dir: "." }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
    httpOnly: true,
    sameSite: "strict",
    secure: isProduction, // Solo HTTPS en producción
  },
  name: "br.sid", // Nombre personalizado (no usar default 'connect.sid')
});

app.use(sessionMiddleware);

// 3. Inicializar Socket.IO (con CORS restrictivo)
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024 * 1024,
  cors: {
    origin: CORS_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

io.engine.on("connection_error", (err) => {
  console.error("ENGINE connection_error:", err.code);
});

// 4. Compartir sesión con Socket.io
const wrap = (middleware) => (socket, next) =>
  middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));

// 5. Configurar Namespace Admin
const adminIo = io.of("/admin");
adminIo.use(wrap(sessionMiddleware));

/* ====================== Configuración Express ====================== */
app.use(express.static(path.join(__dirname, "public")));
const uploadsDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use("/uploads", express.static(uploadsDir, { maxAge: "7d" }));

/* ====================== RUTAS PRINCIPALES ====================== */
app.get("/", (req, res) =>
  res.render("index", { COMPANY_NAME: process.env.COMPANY_NAME || "BR-Group" }),
);
app.get("/widget", (req, res) =>
  res.render("widget", {
    COMPANY_NAME: "BR-Group",
    BOT_NAME: "Asistente",
    PRIMARY_COLOR: "#4f8cff",
  }),
);
app.get("/widget.js", (req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "public", "widget.js"));
});

app.get("/qr-code", async (req, res) => {
  const { qr, ready } = qrStore.get();
  if (ready) return res.send("✅ WhatsApp Conectado");
  if (!qr) return res.send("⏳ Esperando QR...");
  const dataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 8 });
  res.send(`<img src="${dataUrl}" />`);
});

/* ====================== HEALTH CHECK ENDPOINTS ====================== */
const { healthRoute, livenessRoute, readinessRoute } = require("./healthcheck");
app.get("/health", healthRoute);
app.get("/healthz", livenessRoute); // Kubernetes liveness probe
app.get("/readyz", readinessRoute); // Kubernetes readiness probe

/* ====================== LOGIN & AUTH ====================== */
app.get("/login", (req, res) => {
  // Si ya hay sesión activa, redirigir según rol
  if (req.session.userId) {
    if (req.session.userRole === "superadmin") {
      return res.redirect("/super-admin");
    } else {
      return res.redirect("/admin");
    }
  }
  // Si no, mostrar login
  res.render("login", { error: null });
});
// 🛡️ Login con Rate Limiting + Validación
app.post(
  "/login",
  loginLimiter,
  [
    body("username")
      .trim()
      .notEmpty()
      .withMessage("Usuario requerido")
      .isLength({ max: 50 })
      .withMessage("Usuario muy largo")
      .matches(/^[a-zA-Z0-9_]+$/)
      .withMessage("Usuario inválido"),
    body("password")
      .notEmpty()
      .withMessage("Contraseña requerida")
      .isLength({ min: 4, max: 100 })
      .withMessage("Contraseña inválida"),
  ],
  async (req, res) => {
    // Validar inputs
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render("login", { error: errors.array()[0].msg });
    }

    const { username, password } = req.body;
    try {
      const user = await DB.getAgent(username);
      if (!user)
        return res.render("login", { error: "Credenciales incorrectas" }); // Mensaje genérico por seguridad

      const match = await bcrypt.compare(password, user.password);
      if (!match)
        return res.render("login", { error: "Credenciales incorrectas" }); // Mensaje genérico por seguridad

      // Regenerar sesión para prevenir session fixation
      req.session.regenerate((err) => {
        if (err) {
          console.error("Error regenerando sesión:", err);
          return res.render("login", { error: "Error del servidor" });
        }

        // Guardar datos en sesión
        req.session.userId = user.id;
        req.session.userName = user.name;
        req.session.userRole = user.role || "agent";

        // Guardar sesión y redirigir según el rol
        req.session.save(() => {
          if (req.session.userRole === "superadmin") {
            console.log(`🛡️ Super Admin logueado: ${user.name}`);
            res.redirect("/super-admin");
          } else {
            console.log(`👤 Agente logueado: ${user.name}`);
            res.redirect("/admin");
          }
        });
      });
    } catch (e) {
      console.error(e);
      res.render("login", { error: "Error del servidor" });
    }
  },
);

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect("/login");
  next();
}

app.get("/admin", requireAuth, (req, res) => {
  // Si es superadmin y entra a /admin, podrías redirigirlo o dejarlo aquí.
  // Dejamos aquí el panel operativo.
  res.render("admin", {
    agentName: req.session.userName,
    user: req.session.userId,
  });
});

/* ====================== RUTAS SUPER ADMIN (NUEVAS) ====================== */
function requireSuperAdmin(req, res, next) {
  if (
    req.session.userRole !== "superadmin" &&
    req.session.userName !== "admin"
  ) {
    return res.status(403).send("Acceso denegado. Solo Super Admins.");
  }
  next();
}

app.get("/super-admin", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const agents = await DB.getAllAgents();
    res.render("super-admin", { agents, user: req.session.userName });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get(
  "/api/agent-history/:id",
  requireAuth,
  requireSuperAdmin,
  async (req, res) => {
    try {
      const tickets = await DB.getTicketsByAgent(req.params.id);
      res.json(tickets);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

app.get(
  "/api/chat-transcript/:chatId",
  requireAuth,
  requireSuperAdmin,
  async (req, res) => {
    try {
      const history = await DB.getHistory(req.params.chatId);
      res.json(history);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// 1. API Estadísticas
app.get("/api/stats", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const stats = await DB.getStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2. API Crear Agente
app.post("/api/agents", requireAuth, requireSuperAdmin, async (req, res) => {
  const { username, password, name, role } = req.body; // Asegúrate de tener express.json() o urlencoded
  try {
    const id = await DB.createAgent(username, password, name, role || "agent");
    res.json({ success: true, id });
  } catch (e) {
    res.status(400).json({ error: "Error creando usuario. Quizás ya existe." });
  }
});

// 3. API Borrar Agente
app.delete(
  "/api/agents/:id",
  requireAuth,
  requireSuperAdmin,
  async (req, res) => {
    try {
      await DB.deleteAgent(req.params.id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// server.js (Bajo las rutas de super-admin)
app.put("/api/agents/:id", requireAuth, requireSuperAdmin, async (req, res) => {
  const { username, name, role, password } = req.body;
  try {
    await DB.updateAgent(req.params.id, username, name, role, password); // password puede ser null
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API WhatsApp Status (Super Admin only)
app.get("/api/wa-status", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const status = qrStore.get();
    console.log("📱 API /api/wa-status - Estado actual:", status.status);
    // Generate QR data URL if QR exists
    if (status.qr) {
      const qrDataUrl = await QRCode.toDataURL(status.qr, {
        margin: 1,
        scale: 6,
      });
      status.qrDataUrl = qrDataUrl;
    }
    res.json(status);
  } catch (e) {
    console.error("❌ Error en /api/wa-status:", e);
    res.status(500).json({ error: e.message });
  }
});

// API: Chats activos (para super-admin)
app.get("/api/active-chats", requireAuth, requireSuperAdmin, (req, res) => {
  const chats = [];
  for (const [chatId, info] of humanChats.entries()) {
    chats.push({
      chatId,
      agentName: info.agentName,
      agentConnected: !!info.agentId,
      lastActivity: info.lastActivity,
      payload: info.payload || {},
    });
  }
  res.json(chats);
});

/* ====================== SOCKETS - WA STATUS (Super Admin only) ====================== */
const waStatusIo = io.of("/wa-status");
waStatusIo.use(wrap(sessionMiddleware));
waStatusIo.use((socket, next) => {
  const session = socket.request.session;
  if (
    session &&
    session.userId &&
    (session.userRole === "superadmin" || session.userName === "admin")
  ) {
    next();
  } else {
    next(new Error("unauthorized - superadmin only"));
  }
});

waStatusIo.on("connection", async (socket) => {
  console.log("📱 Super-admin conectado a wa-status, socket.id:", socket.id);
  console.log("📱 Total clientes wa-status:", waStatusIo.sockets.size);
  // Send current status on connect
  const currentStatus = qrStore.get();
  console.log("📱 Estado actual en archivo:", JSON.stringify(currentStatus));

  // If QR exists, generate data URL
  if (currentStatus.qr) {
    try {
      currentStatus.qrDataUrl = await QRCode.toDataURL(currentStatus.qr, {
        margin: 1,
        scale: 6,
      });
    } catch (e) {
      console.error("Error generando QR:", e);
    }
  }

  socket.emit("wa_status", currentStatus);
});

/* ====================== SOCKETS - BRIDGE (WhatsApp) ====================== */
const bridgeIo = io.of("/bridge");
const bridgeChats = new Map();

bridgeIo.on("connection", (socket) => {
  socket.on("register_chat", ({ chatId }) => {
    if (chatId) bridgeChats.set(chatId, socket.id);
  });
  socket.on("enqueue", (rec) => addToQueue(rec, adminIo));
  socket.on("push_transcript", ({ chatId, msg }) => {
    if (!chatId || !msg) return;
    pushTranscript(chatId, msg);
    fanoutToAgentIfNeeded(chatId, msg);
    // Actualizar lastActivity si es mensaje de usuario
    const hcBridge = humanChats.get(chatId);
    if (hcBridge && msg.who === "user") hcBridge.lastActivity = Date.now();
  });
  // Forward wa_status events to super-admin namespace
  socket.on("wa_status", async (data) => {
    console.log("📱 Bridge recibió wa_status:", data.status);
    console.log("📱 Clientes conectados a wa-status:", waStatusIo.sockets.size);

    // If QR exists, generate data URL
    if (data.qr && !data.qrDataUrl) {
      try {
        data.qrDataUrl = await QRCode.toDataURL(data.qr, {
          margin: 1,
          scale: 6,
        });
      } catch (e) {
        console.error("Error generando QR:", e);
      }
    }

    console.log("📱 Emitiendo wa_status a super-admins:", data.status);
    waStatusIo.emit("wa_status", data);
  });
  socket.on("disconnect", () => {
    for (const [id, sid] of bridgeChats.entries())
      if (sid === socket.id) bridgeChats.delete(id);
  });
});

function fanoutToAgentIfNeeded(chatId, payload) {
  const info = humanChats.get(chatId);
  if (info && info.agentId)
    adminIo.to(info.agentId).emit("chat_message", { chatId, ...payload });
}

function endHumanChat(chatId, who, io, adminIo) {
  const info = humanChats.get(chatId);
  if (!info) return;
  humanChats.delete(chatId);

  const msgUser =
    who === "agent"
      ? "✅ El agente finalizó la conversación."
      : who === "timeout"
        ? "⏱️ La conversación fue cerrada por inactividad."
        : "✅ Finalizaste la conversación.";
  io.to(chatId).emit("system_message", { text: msgUser });
  io.to(chatId).emit("agent_finished", {});

  if (who !== "timeout") {
    io.to(chatId).emit("rate_request", { agent: info.agentName || "Agente" });
    pushTranscript(chatId, { who: "system", text: "Solicitud de calificación.", ts: Date.now() });
  }

  pushTranscript(chatId, {
    who: "system",
    text: who === "timeout" ? "Chat cerrado por inactividad." : "Chat finalizado.",
    ts: Date.now(),
  });

  // Notificar al agente con evento dedicado
  if (info.agentId) {
    adminIo.to(info.agentId).emit("chat_ended", { chatId, reason: who });
  }

  clearAIModeTimer(chatId);
  reset(chatId);
}

/* ====================== SOCKETS - ADMIN PANEL ====================== */
adminIo.use((socket, next) => {
  const session = socket.request.session;
  if (session && session.userId) {
    socket.agentUser = session;
    next();
  } else {
    next(new Error("unauthorized"));
  }
});

adminIo.on("connection", async (socket) => {
  socket.emit("queue_snapshot", Array.from(pendingChats.values()));

  // Reconectar chats activos de este agente
  const myUserId = socket.agentUser.userId;
  const activeChats = [];
  for (const [chatId, info] of humanChats.entries()) {
    if (info.agentUserId === myUserId) {
      info.agentId = socket.id; // actualizar socket efímero
      let transcript = [];
      try { transcript = await DB.getHistory(chatId); } catch (e) { /* */ }
      if (transcript.length === 0 && conversations.has(chatId))
        transcript = conversations.get(chatId);
      activeChats.push({ chatId, transcript, payload: info.payload || {}, noTimeout: !!info.noTimeout });
    }
  }
  if (activeChats.length > 0) socket.emit("active_chats", activeChats);

  socket.on("assign", async ({ chatId }) => {
    // 1. Obtener datos del agente desde la sesión
    const agentName = socket.agentUser.userName;
    const agentId = socket.agentUser.userId;

    // 2. Recuperar datos de la cola antes de borrarlos
    const rec = pendingChats.get(chatId);
    const payload = rec?.payload || {};

    // 3. Quitar de la cola
    removeFromQueue(chatId, adminIo);

    // 4. 👇 LÓGICA DE CLASIFICACIÓN DE TEMA (TOPIC) 👇
    let topic = "Consulta General";

    if (payload.categoria) {
      // Caso Mantenimiento (ej: "Plomería")
      topic = `🛠 ${payload.categoria}`;
    } else if (payload.propform) {
      // Caso Inmobiliaria (ej: "Alquiler Depto")
      const op =
        payload.propform.op === "alquilar"
          ? "Alquiler"
          : payload.propform.op === "comprar"
            ? "Venta"
            : payload.propform.op || "Propiedad";
      const tipo = payload.propform.tipo || "";
      topic = `🏠 ${op} ${tipo}`.trim();
    } else if (payload.indice) {
      // Caso Calculadora (ej: "ICL")
      topic = `📈 ${payload.indice}`;
    } else if (payload.motivo) {
      // Caso Genérico (limpiamos el texto sucio del menú)
      topic = payload.motivo.replace("(número)", "").trim();
    }

    // 5. Actualizar estado en memoria (Chat activo)
    humanChats.set(chatId, {
      agentId: socket.id,
      agentUserId: agentId,
      agentName,
      payload,
      lastActivity: Date.now(),
    });

    // 6. Apagar el timer de la IA para que no moleste
    clearAIModeTimer(chatId);

    // 7. Recuperar historial de mensajes
    let transcript = [];
    try {
      // Intentamos leer de la DB
      transcript = await DB.getHistory(chatId);
    } catch (e) {
      console.error("Error historial DB", e);
    }
    // Fallback: Si la DB falla o está vacía, intentamos leer de la memoria RAM
    if (transcript.length === 0 && conversations.has(chatId)) {
      transcript = conversations.get(chatId);
    }

    // 8. Enviar evento al panel del agente (para que se abra el chat)
    socket.emit("assigned", { chatId, transcript, payload });

    // 9. 🔥 CREAR TICKET EN BASE DE DATOS CON EL TEMA DETECTADO
    DB.createTicket(agentId, chatId, topic);

    // 10. Avisar al Bridge (WhatsApp)
    const sid = bridgeChats.get(chatId);
    if (sid) {
      bridgeIo.to(sid).emit("agent_assigned", { chatId, agent: agentName });
    }

    // 11. Avisar al Cliente Web (si está conectado por web)
    // io.to(chatId) funciona tanto para socket.id como para rooms custom
    io.to(chatId).emit("system_message", {
      text: `👤 ${agentName} tomó tu caso.`,
    });
    io.to(chatId).emit("agent_assigned", { agent: agentName });

    // 12. Registrar evento en el historial del chat
    const ts = Date.now();
    pushTranscript(chatId, {
      who: "system",
      text: `Agente asignado: ${agentName}`,
      ts,
    });
    fanoutToAgentIfNeeded(chatId, {
      who: "system",
      text: `Agente asignado`,
      ts,
    });
  });

  socket.on("agent_message", ({ chatId, text }) => {
    if (!chatId || !text) return;
    const ts = Date.now();
    pushTranscript(chatId, { who: "agent", text, ts, type: "text" });
    io.to(chatId).emit("agent_message", { text });

    if (bridgeChats.has(chatId))
      bridgeIo
        .to(bridgeChats.get(chatId))
        .emit("deliver_to_user", { chatId, text });
    fanoutToAgentIfNeeded(chatId, { who: "agent", text, ts, type: "text" });

    // Actualizar lastActivity
    const hc = humanChats.get(chatId);
    if (hc) hc.lastActivity = ts;
  });

  // Agente envía imagen al cliente
  socket.on("agent_image", ({ chatId, name, type, data }) => {
    if (!chatId || !data) return;
    try {
      const base64 = String(data).split(",")[1];
      if (!base64) return;
      const ext = (type && type.split("/")[1]) || "png";
      const fname = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const filePath = path.join(uploadsDir, fname);
      fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
      const url = `/uploads/${fname}`;
      const ts = Date.now();
      pushTranscript(chatId, { who: "agent", url, type: "image", ts });
      // Enviar al chat web del cliente
      io.to(chatId).emit("agent_message", { text: "", type: "image", url });
      // Enviar al bridge de WhatsApp
      if (bridgeChats.has(chatId)) {
        bridgeIo.to(bridgeChats.get(chatId)).emit("deliver_image_to_user", { chatId, url, filePath });
      }
      // Actualizar lastActivity
      const hcAi = humanChats.get(chatId);
      if (hcAi) hcAi.lastActivity = ts;
    } catch (e) {
      console.error("Error agent_image:", e);
    }
  });

  // Toggle timeout por chat individual
  socket.on("toggle_timeout", ({ chatId, noTimeout }) => {
    const info = humanChats.get(chatId);
    if (info) info.noTimeout = !!noTimeout;
  });

  // Toggle timeout global (todos los chats del agente)
  socket.on("toggle_timeout_global", ({ noTimeout }) => {
    const uid = socket.agentUser.userId;
    for (const [, info] of humanChats.entries()) {
      if (info.agentUserId === uid) info.noTimeout = !!noTimeout;
    }
  });

  // 🔥 UNIFICADO: Evento Finish (Cerrar Ticket + UI)
  socket.on("finish", ({ chatId }) => {
    const agentId = socket.agentUser.userId;

    // 1. Cerrar Ticket en DB
    DB.closeTicket(chatId, agentId);

    // 2. Finalizar Chat en UI/Socket
    endHumanChat(chatId, "agent", io, adminIo);

    // 3. Avisar al bridge de WhatsApp
    if (bridgeChats.has(chatId)) {
      bridgeIo.to(bridgeChats.get(chatId)).emit("finish", { chatId });
    }
  });

  socket.on("disconnect", () => {
    // No borrar chats activos: el agente puede reconectar
    for (const [chatId, info] of humanChats.entries()) {
      if (info.agentId === socket.id) {
        info.agentId = null; // marcar como desconectado temporalmente
      }
    }
  });
});

/* ====================== SOCKETS - USUARIO WEB ====================== */
io.on("connection", async (socket) => {
  console.log("🟢 Cliente WEB conectado", socket.id);

  // El chatId persistente se asigna cuando el cliente envía register_chat
  socket.chatId = socket.id; // default hasta register

  socket.on("register_chat", async ({ chatId }) => {
    if (!chatId || socket._registered) return;
    socket._registered = true;
    socket.chatId = chatId;
    socket.join(chatId);

    // Verificar si ya tiene conversación activa
    const inHuman = humanChats.has(chatId);
    const hasConvo = conversations.has(chatId) || inHuman;

    if (hasConvo) {
      // Restaurar: enviar transcript y estado
      let transcript = [];
      try { transcript = await DB.getHistory(chatId); } catch (e) { /* */ }
      if (transcript.length === 0 && conversations.has(chatId))
        transcript = conversations.get(chatId);

      socket.emit("restore_state", {
        transcript,
        humanMode: inHuman,
        agentName: inHuman ? humanChats.get(chatId).agentName : null,
      });
      return; // no enviar menú de nuevo
    }

    // Primera vez: enviar menú inicial
    const { replies, session } = await handleText({
      chatId,
      text: "menu",
      channel: "web",
    });
    replies.forEach((t) => {
      socket.emit("bot_message", { text: t });
      pushTranscript(chatId, { who: "bot", text: t, ts: Date.now(), type: "text" });
    });
    const btns = buildButtonsForStep(session);
    if (btns?.length) {
      socket.emit("bot_message", { text: "Opciones:", buttons: btns });
      pushTranscript(chatId, { who: "bot", text: "Opciones:", buttons: btns, ts: Date.now(), type: "text" });
    }
  });

  socket.on("user_message", async (msg) => {
    const cid = socket.chatId;
    const text = msg && msg.text ? String(msg.text) : "";
    const ts = Date.now();

    // Registrar mensaje del usuario
    pushTranscript(cid, { who: "user", text, ts, type: "text" });
    fanoutToAgentIfNeeded(cid, { who: "user", text, ts, type: "text" });

    // Actualizar lastActivity
    const hcUser = humanChats.get(cid);
    if (hcUser) hcUser.lastActivity = ts;

    // Si ya lo atiende un humano, ignorar al bot
    if (humanChats.has(cid)) return;

    // Procesar con el Engine
    const { replies, notifyAgent, session, aiSignal, ui } = await handleText({
      chatId: cid,
      text,
      channel: "web",
    });

    // --- 🔥 LÓGICA DE ORDENAMIENTO VISUAL ---

    // 1. Si hay tarjetas, separamos el último mensaje de texto (la pregunta)
    let finalQuestion = null;
    if (ui?.cards?.length && replies.length > 0) {
      finalQuestion = replies.pop(); // Sacamos el último para enviarlo al final
    }

    // 2. Enviamos los mensajes de texto introductorios
    replies.forEach((t) => {
      socket.emit("bot_message", { text: t });
      pushTranscript(cid, {
        who: "bot",
        text: t,
        ts: Date.now(),
        type: "text",
      });
      fanoutToAgentIfNeeded(cid, {
        who: "bot",
        text: t,
        ts: Date.now(),
        type: "text",
      });
    });

    // 3. Enviamos las Tarjetas (si existen)
    if (ui?.cards?.length) {
      socket.emit("bot_message", { type: "property_cards", cards: ui.cards });
      pushTranscript(cid, {
        who: "bot",
        text: "[Cards]",
        ts: Date.now(),
        type: "property_cards",
      });
    }

    // 4. Enviamos la Pregunta Final y los Botones (con delay si hubo cards)
    if (finalQuestion) {
      setTimeout(() => {
        // Enviar pregunta
        socket.emit("bot_message", { text: finalQuestion });
        pushTranscript(cid, {
          who: "bot",
          text: finalQuestion,
          ts: Date.now(),
          type: "text",
        });
        fanoutToAgentIfNeeded(cid, {
          who: "bot",
          text: finalQuestion,
          ts: Date.now(),
          type: "text",
        });

        // Enviar botones (si corresponde al paso actual)
        const b = buildButtonsForStep(session);
        if (b?.length) {
          socket.emit("bot_message", { text: "Opciones:", buttons: b });
          pushTranscript(cid, {
            who: "bot",
            text: "Opciones:",
            buttons: b,
            ts: Date.now(),
            type: "text",
          });
        }
      }, 600); // ⏳ Pequeña espera para asegurar que las cards se rendericen primero
    } else {
      // Flujo normal (sin cards o sin pregunta final separada)
      const b = buildButtonsForStep(session);
      if (b?.length) {
        socket.emit("bot_message", { text: "Opciones:", buttons: b });
        pushTranscript(cid, {
          who: "bot",
          text: "Opciones:",
          buttons: b,
          ts: Date.now(),
          type: "text",
        });
      }
    }
    // ----------------------------------------

    // Manejo de IA (Timeouts)
    if (aiSignal?.mode === "on" || aiSignal?.mode === "extend") {
      if (aiSignal.until) scheduleAIModeTimeout(cid, aiSignal.until);
    }
    if (aiSignal?.mode === "off") clearAIModeTimer(cid);

    // Notificación a Agentes (Cola de espera)
    if (notifyAgent) {
      const rec = {
        chatId: cid,
        since: Date.now(),
        payload: notifyAgent,
      };
      addToQueue(rec, adminIo);
      socket.emit("system_message", { text: "📣 Un agente fue notificado." });
      pushTranscript(cid, {
        who: "system",
        text: "Encolado",
        ts: Date.now(),
      });
    }
  });

  socket.on("user_image", async (payload) => {
    const cid = socket.chatId;
    try {
      const { name, type, data } = payload || {};
      const base64 = String(data || "").split(",")[1];
      if (!base64) return;
      const ext = (type && type.split("/")[1]) || "png";
      const fname = `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.${ext}`;
      const filePath = path.join(uploadsDir, fname);
      fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
      const url = `/uploads/${fname}`;
      const ts = Date.now();

      pushTranscript(cid, { who: "user", url, type: "image", ts });
      fanoutToAgentIfNeeded(cid, { who: "user", url, type: "image", ts });

      // Actualizar lastActivity
      const hcImg = humanChats.get(cid);
      if (hcImg) hcImg.lastActivity = ts;

      if (humanChats.has(cid)) {
        socket.emit("system_message", { text: "📸 Imagen enviada al agente." });
        return;
      }

      const { replies } = await handleImage({
        chatId: cid,
        file: { url, type: type || "image/*", name: name || fname },
      });
      replies.forEach((t) => {
        socket.emit("bot_message", { text: t });
        pushTranscript(cid, { who: "bot", text: t, ts: Date.now() });
      });
    } catch (e) {
      console.error(e);
    }
  });

  socket.on("user_finish", () => endHumanChat(socket.chatId, "user", io, adminIo));

  socket.on("rate_submit", async ({ stars, skipped }) => {
    const cid = socket.chatId;
    const txt = skipped ? "Rating omitido" : `Rating: ${stars} estrellas`;

    // 1. Guardar en DB
    if (!skipped && stars) {
      await DB.saveRating(cid, stars);
    }

    // 2. Registrar en transcript
    pushTranscript(cid, { who: "system", text: txt, ts: Date.now() });

    // 3. Agradecer
    io.to(cid).emit("system_message", {
      text: "¡Gracias por tu opinión!",
    });

    // 🔥 CAMBIO: En lugar de ir al menú directo, preguntamos
    const s = getSession(cid);
    s.step = "rate_followup"; // Nuevo estado temporal

    const followUpMsg = "¿Deseás realizar alguna otra consulta? (Sí / No)";

    const followBtns = [
      { label: "Sí", value: "sí" },
      { label: "No", value: "no" },
    ];
    io.to(cid).emit("bot_message", {
      text: followUpMsg,
      buttons: followBtns,
    });

    pushTranscript(cid, {
      who: "bot",
      text: followUpMsg,
      buttons: followBtns,
      ts: Date.now(),
    });
  });

  socket.on("disconnect", () => {
    // No borrar humanChats en disconnect del cliente web
    // porque puede reconectar (recarga de página)
    // Solo limpiar de la cola si estaba pendiente
    removeFromQueue(socket.chatId, adminIo);
  });
});

/* ====================== Inactivity Timer ====================== */
setInterval(() => {
  const now = Date.now();
  for (const [chatId, info] of humanChats.entries()) {
    if (info.noTimeout) continue; // chat marcado como sin timeout
    if (info.lastActivity && (now - info.lastActivity) > INACTIVITY_TIMEOUT_MS) {
      console.log(`⏱️ Inactividad: cerrando chat ${chatId}`);
      DB.closeTicket(chatId, info.agentUserId);
      endHumanChat(chatId, "timeout", io, adminIo);
      const sid = bridgeChats.get(chatId);
      if (sid) bridgeIo.to(sid).emit("finish", { chatId });
    }
  }
}, 60 * 1000);

/* ====================== Start ====================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, "::", () => {
  console.log(`🌐 Web chat listo en http://localhost:${PORT}`);
  console.log(`🛠️  Panel admin: http://localhost:${PORT}/admin`);
});
