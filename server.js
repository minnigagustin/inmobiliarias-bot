// server.js — Web chat + botones + Panel Admin con handoff en vivo
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const qrStore = require("./wa-qr-store");

require("dotenv").config();

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
    // y para la moneda:
    case "ind_moneda":
    case "prop_moneda":
      return [
        { label: "1. Pesos (ARS)", value: "1" },
        { label: "2. Dólares (USD)", value: "2" },
      ];

    default:
      return null;
  }
}

/* ====================== Cola + handoff + transcript ====================== */
const pendingChats = new Map(); // chatId -> { chatId, since, payload }
const conversations = new Map(); // chatId -> [{who, text?, url?, type, ts}]
const humanChats = new Map(); // chatId -> { agentId, agentName }
// 👇 Timers para modo IA proactivo
const aiTimers = new Map(); // chatId -> timeoutId

function addToQueue(rec, adminIo) {
  pendingChats.set(rec.chatId, rec);
  adminIo.emit("queue_add", rec);
}
function removeFromQueue(chatId, adminIo) {
  if (pendingChats.delete(chatId)) adminIo.emit("queue_remove", { chatId });
}
function pushTranscript(chatId, msg) {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  conversations.get(chatId).push(msg);
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
    // si están con agente, no molestamos
    if (humanChats.has(chatId)) return clearAIModeTimer(chatId);

    const s = getSession(chatId);
    const stillAI = s && s.step === "consultas_ia" && s.data?.ai?.active;
    if (!stillAI) return clearAIModeTimer(chatId);

    engineExitAI(chatId); // pasa a consultas_menu
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

/* ====================== Server & Sockets ====================== */
const app = express();

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024 * 1024,
  cors: {
    origin: true, // ✅ permite cualquier origin
    methods: ["GET", "POST"],
    credentials: true, // podés dejarlo true o false
  },
});

// Loguear por qué falla, si falla
io.engine.on("connection_error", (err) => {
  console.error("ENGINE connection_error:", {
    code: err.code,
    message: err.message,
    context: err.context,
  });
});
app.use(express.static(path.join(__dirname, "public")));
const uploadsDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.get("/", (req, res) => {
  res.render("index", {
    COMPANY_NAME: process.env.COMPANY_NAME || "BR-Group",
  });
});
app.use("/uploads", express.static(uploadsDir, { maxAge: "7d" }));

app.get("/qr-code", async (req, res) => {
  const { qr, ready } = qrStore.get();

  // (Opcional) proteger con token simple
  // if (process.env.ADMIN_TOKEN && req.query.token !== process.env.ADMIN_TOKEN) {
  //   return res.status(401).send("unauthorized");
  // }

  const brand = process.env.BOT_BRAND || "Tu Asistente Virtual";
  const subtitle =
    "Bienvenido a la configuración. Para conectar WhatsApp, escaneá el código QR desde WhatsApp Web.";

  // helpers de UI
  const page = ({ title, badge, bodyHtml, refreshMs }) => `
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  ${
    refreshMs
      ? `<meta http-equiv="refresh" content="${Math.ceil(refreshMs / 1000)}" />`
      : ""
  }

  <style>
    :root{
      --bg1:#0b1020; --bg2:#111a33;
      --card: rgba(255,255,255,.08);
      --card2: rgba(255,255,255,.12);
      --txt:#e9ecff; --muted: rgba(233,236,255,.72);
      --line: rgba(233,236,255,.14);
      --ok:#22c55e; --wait:#f59e0b; --err:#ef4444;
      --shadow: 0 24px 70px rgba(0,0,0,.45);
      --radius: 18px;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New";
      --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      min-height:100vh;
      font-family: var(--sans);
      color: var(--txt);
      background:
        radial-gradient(1200px 600px at 18% 18%, rgba(99,102,241,.25), transparent 55%),
        radial-gradient(1000px 600px at 80% 10%, rgba(34,197,94,.18), transparent 55%),
        radial-gradient(900px 600px at 50% 90%, rgba(245,158,11,.14), transparent 55%),
        linear-gradient(160deg, var(--bg1), var(--bg2));
      display:flex;
      align-items:center;
      justify-content:center;
      padding: 28px 16px;
    }
    .wrap{width:100%; max-width: 980px;}
    .top{
      display:flex; align-items:center; justify-content:space-between;
      gap:16px; margin-bottom: 16px;
    }
    .brand{
      display:flex; align-items:center; gap:12px;
    }
    .logo{
      width:44px;height:44px;border-radius: 12px;
      background: linear-gradient(135deg, rgba(99,102,241,.9), rgba(34,197,94,.75));
      box-shadow: 0 10px 24px rgba(0,0,0,.35);
    }
    h1{font-size: 20px; margin:0; letter-spacing:.2px}
    .sub{margin:2px 0 0; color: var(--muted); font-size: 13px}
    .badge{
      padding:8px 12px;
      border-radius: 999px;
      background: rgba(255,255,255,.10);
      border: 1px solid var(--line);
      font-size: 12px;
      display:flex; align-items:center; gap:8px;
      white-space:nowrap;
    }
    .dot{width:10px;height:10px;border-radius:50%}
    .grid{
      display:grid;
      grid-template-columns: 1.2fr .8fr;
      gap:16px;
    }
    @media (max-width: 860px){
      .grid{grid-template-columns: 1fr;}
      .badge{justify-content:center}
      .top{flex-direction:column; align-items:flex-start}
    }
    .card{
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow:hidden;
    }
    .cardHeader{
      padding: 16px 18px;
      background: linear-gradient(180deg, rgba(255,255,255,.10), transparent);
      border-bottom: 1px solid var(--line);
    }
    .cardBody{padding: 18px;}
    .title{font-size: 16px; margin:0 0 6px}
    .muted{color: var(--muted); margin:0; font-size: 13px; line-height:1.5}
    .qrBox{
      margin-top:14px;
      display:flex; align-items:center; justify-content:center;
      padding: 18px;
      border-radius: 16px;
      background: rgba(255,255,255,.06);
      border: 1px dashed rgba(233,236,255,.22);
    }
    .qrBox img{
      width: 340px;
      max-width: 100%;
      height: auto;
      border-radius: 12px;
      background: #fff;
      padding: 12px;
    }
    .steps{
      display:flex; flex-direction:column; gap:12px;
    }
    .step{
      padding: 14px 14px;
      border-radius: 14px;
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(233,236,255,.12);
    }
    .step strong{display:block; font-size: 13px; margin-bottom: 4px}
    .step p{margin:0; color: var(--muted); font-size: 13px; line-height:1.45}
    .kbd{
      font-family: var(--mono);
      font-size: 12px;
      padding: 2px 8px;
      border: 1px solid rgba(233,236,255,.20);
      border-bottom-color: rgba(233,236,255,.12);
      border-radius: 10px;
      background: rgba(255,255,255,.06);
      display:inline-block;
    }
    .footer{
      margin-top: 14px;
      display:flex;
      gap:10px;
      flex-wrap:wrap;
      color: var(--muted);
      font-size: 12px;
      align-items:center;
      justify-content:space-between;
    }
    .hint{display:flex; gap:10px; align-items:center;}
    .pill{
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(233,236,255,.12);
    }
    .btn{
      appearance:none;
      border: 1px solid rgba(233,236,255,.18);
      background: rgba(255,255,255,.08);
      color: var(--txt);
      padding: 9px 12px;
      border-radius: 12px;
      cursor:pointer;
      font-size: 13px;
    }
    .btn:hover{background: rgba(255,255,255,.12)}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="brand">
        <div class="logo"></div>
        <div>
          <h1>${brand}</h1>
          <p class="sub">${subtitle}</p>
        </div>
      </div>
      <div class="badge">
        <span class="dot" style="background:${badge.color}"></span>
        <span>${badge.text}</span>
      </div>
    </div>

    <div class="grid">
      <section class="card">
        <div class="cardHeader">
          <h2 class="title">${title}</h2>
          <p class="muted">Abrí WhatsApp en tu teléfono → <strong>Dispositivos vinculados</strong> → <strong>Vincular un dispositivo</strong> y escaneá.</p>
        </div>
        <div class="cardBody">
          ${bodyHtml}
          <div class="footer">
            <div class="hint">
              <span class="pill">Actualización automática</span>
              <span class="pill">Acceso privado recomendado</span>
            </div>
            <div>
              <button class="btn" onclick="location.reload()">Actualizar ahora</button>
            </div>
          </div>
        </div>
      </section>

      <aside class="card">
        <div class="cardHeader">
          <h2 class="title">Pasos rápidos</h2>
          <p class="muted">Conectá WhatsApp en menos de 1 minuto.</p>
        </div>
        <div class="cardBody">
          <div class="steps">
            <div class="step">
              <strong>1) Abrí WhatsApp</strong>
              <p>En tu celular, andá a <span class="kbd">⋮</span> / Ajustes → <b>Dispositivos vinculados</b>.</p>
            </div>
            <div class="step">
              <strong>2) Vincular un dispositivo</strong>
              <p>Elegí <b>Vincular un dispositivo</b> y dejá la cámara lista.</p>
            </div>
            <div class="step">
              <strong>3) Escaneá el QR</strong>
              <p>Si el QR expira, esta pantalla lo renueva automáticamente.</p>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </div>

  <script>
    // refresco suave (además del meta refresh)
    ${refreshMs ? `setTimeout(()=>location.reload(), ${refreshMs});` : ""}
  </script>
</body>
</html>
`;

  // ---- estados ----
  if (ready) {
    return res.send(
      page({
        title: "✅ WhatsApp conectado",
        badge: { text: "Conectado", color: "var(--ok)" },
        bodyHtml: `
          <p class="muted">Tu cuenta ya está vinculada. Si querés volver a escanear, cerrá sesión en WhatsApp Web o eliminá la sesión guardada.</p>
        `,
        refreshMs: 0,
      })
    );
  }

  if (!qr) {
    return res.send(
      page({
        title: "⏳ Generando código QR…",
        badge: { text: "Esperando QR", color: "var(--wait)" },
        bodyHtml: `
          <p class="muted">Aún no llegó un QR. Esto puede tardar unos segundos al iniciar el servicio.</p>
          <div class="qrBox">
            <div>
              <p class="muted" style="margin:0 0 8px;">Cuando esté listo, aparecerá aquí automáticamente.</p>
              <div class="pill">Reintentando…</div>
            </div>
          </div>
        `,
        refreshMs: 2000,
      })
    );
  }

  const dataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 8 });

  return res.send(
    page({
      title: "Escaneá el QR para vincular WhatsApp",
      badge: { text: "Listo para escanear", color: "var(--ok)" },
      bodyHtml: `
        <div class="qrBox">
          <img src="${dataUrl}" alt="QR de WhatsApp" />
        </div>
        <p class="muted" style="margin-top:12px;">
          Consejo: mantené esta pestaña abierta. Si cambia el QR, se actualizará solo.
        </p>
      `,
      refreshMs: 5000,
    })
  );
});

const adminIo = io.of("/admin");

// === Bridge para canales externos (WhatsApp) ===
const bridgeIo = io.of("/bridge");
const bridgeChats = new Map(); // chatId -> socketId del bridge

bridgeIo.on("connection", (socket) => {
  // WA se registra con el chatId (JID de WhatsApp)
  socket.on("register_chat", ({ chatId }) => {
    if (chatId) bridgeChats.set(chatId, socket.id);
  });

  // WA encola casos para el panel admin
  socket.on("enqueue", (rec) => addToQueue(rec, adminIo));

  // WA empuja transcript (user/bot/media)
  socket.on("push_transcript", ({ chatId, msg }) => {
    if (!chatId || !msg) return;
    pushTranscript(chatId, msg);
    fanoutToAgentIfNeeded(chatId, msg);
  });

  socket.on("disconnect", () => {
    for (const [id, sid] of bridgeChats.entries())
      if (sid === socket.id) bridgeChats.delete(id);
  });
});

// (Opcional) auth por token simple
adminIo.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (process.env.ADMIN_TOKEN && token !== process.env.ADMIN_TOKEN) {
    return next(new Error("unauthorized"));
  }
  next();
});

// Enviar mensajes a agente si el chat está en modo humano
function fanoutToAgentIfNeeded(chatId, payload) {
  const info = humanChats.get(chatId);
  if (info) {
    adminIo.to(info.agentId).emit("chat_message", { chatId, ...payload });
  }
}

function endHumanChat(chatId, who, io, adminIo) {
  const info = humanChats.get(chatId);
  if (!info) return;
  humanChats.delete(chatId);

  const msgUser =
    who === "agent"
      ? "✅ El agente finalizó la conversación. Volvemos al asistente."
      : "✅ Finalizaste la conversación. Volvemos al asistente.";

  io.to(chatId).emit("system_message", { text: msgUser });
  io.to(chatId).emit("agent_finished", {});

  // ⭐ Pedir calificación (5 estrellas u omitir)
  io.to(chatId).emit("rate_request", { agent: info.agentName || "Agente" });
  pushTranscript(chatId, {
    who: "system",
    text: "Se solicitó una calificación.",
    ts: Date.now(),
  });

  // Aviso al agente…
  adminIo.to(info.agentId).emit("chat_message", {
    chatId,
    who: "system",
    text:
      who === "agent"
        ? "Conversación finalizada por el agente."
        : "Conversación finalizada por el usuario.",
    ts: Date.now(),
  });

  // 🔴 limpiar timer de IA si estaba activo
  clearAIModeTimer(chatId);

  // Reset del flujo del bot (la UI volverá al menú tras rate_submit)
  reset(chatId);
}

/* ===== Panel de agentes ===== */
adminIo.on("connection", (socket) => {
  // Snapshot inicial de la cola
  socket.emit("queue_snapshot", Array.from(pendingChats.values()));

  // Asignación de un chat al agente
  socket.on("assign", ({ chatId, agent }) => {
    // 1) Tomo el registro ANTES de removerlo de la cola
    const rec = pendingChats.get(chatId) || null;
    const payload = rec?.payload || null;

    removeFromQueue(chatId, adminIo);

    // 2) Marcar chat en modo humano en el server (aplica a web y WA)
    humanChats.set(chatId, {
      agentId: socket.id,
      agentName: agent || "Agente",
    });

    // 🧹 cortar timer IA si estaba corriendo (para no notificar en medio del handoff)
    clearAIModeTimer(chatId);

    // 3) Enviar snapshot al agente (incluye payload del caso)
    const transcript = conversations.get(chatId) || [];
    socket.emit("assigned", { chatId, transcript, payload });

    // 4) Si es un chat de WhatsApp (registrado en el bridge), avisarle al proceso WA
    const sid = bridgeChats.get(chatId);
    if (sid) {
      bridgeIo.to(sid).emit("agent_assigned", { chatId, agent });
    }

    // 5) Notificar al usuario web (si existe un socket con ese id)
    if (io.sockets.sockets.has(chatId)) {
      io.to(chatId).emit("system_message", {
        text: `👤 ${agent || "Un agente"} tomó tu caso.`,
      });
      io.to(chatId).emit("agent_assigned", { agent: agent || "Agente" });
    }

    // 6) Transcript y eco al panel
    const ts = Date.now();
    pushTranscript(chatId, {
      who: "system",
      text: `Agente asignado: ${agent || "Agente"}`,
      ts,
    });
    fanoutToAgentIfNeeded(chatId, {
      who: "system",
      text: `Agente asignado`,
      ts,
    });
  });

  // Mensaje del agente hacia el usuario
  socket.on("agent_message", ({ chatId, text }) => {
    if (!chatId || !text) return;
    const ts = Date.now();
    // guardar y enviar al usuario
    pushTranscript(chatId, { who: "agent", text, ts, type: "text" });
    io.to(chatId).emit("agent_message", { text });

    if (bridgeChats.has(chatId)) {
      bridgeIo
        .to(bridgeChats.get(chatId))
        .emit("deliver_to_user", { chatId, text });
    }
    // eco al propio agente (por si hay varios)
    fanoutToAgentIfNeeded(chatId, { who: "agent", text, ts, type: "text" });
  });

  // 👇 NUEVO: el agente finaliza
  socket.on("finish", ({ chatId }) => {
    endHumanChat(chatId, "agent", io, adminIo);
    if (bridgeChats.has(chatId)) {
      bridgeIo.to(bridgeChats.get(chatId)).emit("finish", { chatId });
    }
  });

  // Limpieza si el agente se desconecta
  socket.on("disconnect", () => {
    for (const [chatId, info] of humanChats.entries()) {
      if (info.agentId === socket.id) {
        humanChats.delete(chatId);
        const ts = Date.now();
        io.to(chatId).emit("system_message", {
          text: "ℹ️ El agente se desconectó. Volvemos al asistente.",
        });
        // 👇 FALTA: que el cliente apague el banner y vuelva al bot
        io.to(chatId).emit("agent_finished", {});
        pushTranscript(chatId, {
          who: "system",
          text: "Agente desconectado",
          ts,
        });
        // 🔴 limpiar timer IA si estaba activo
        clearAIModeTimer(chatId);
        // (opcional) resetear FSM del bot para empezar limpio
        reset(chatId);
      }
    }
  });
});

/* ===== Usuarios del chat ===== */
io.on("connection", async (socket) => {
  console.log("🟢 Cliente conectado", socket.id);

  // ⬇️ Mostrar menú principal reutilizando el engine
  const { replies, session } = await handleText({
    chatId: socket.id,
    text: "menu",
  });

  replies.forEach((t) => {
    socket.emit("bot_message", { text: t });
    pushTranscript(socket.id, {
      who: "bot",
      text: t,
      ts: Date.now(),
      type: "text",
    });
    fanoutToAgentIfNeeded(socket.id, {
      who: "bot",
      text: t,
      ts: Date.now(),
      type: "text",
    });
  });

  // Botones contextuales del menú principal
  const buttons = buildButtonsForStep(session);
  if (buttons?.length) {
    const txt = "Elegí una opción:";
    socket.emit("bot_message", { text: txt, buttons });
    pushTranscript(socket.id, {
      who: "bot",
      text: txt,
      ts: Date.now(),
      type: "text",
    });
    fanoutToAgentIfNeeded(socket.id, {
      who: "bot",
      text: txt,
      ts: Date.now(),
      type: "text",
    });
  }
  // texto del usuario
  socket.on("user_message", async (msg) => {
    const text = msg && msg.text ? String(msg.text) : "";
    const ts = Date.now();

    // guardar siempre en transcript
    pushTranscript(socket.id, { who: "user", text, ts, type: "text" });
    fanoutToAgentIfNeeded(socket.id, { who: "user", text, ts, type: "text" });

    // 👇 BLOQUEA BOT si el chat está con agente (esto evita que “salte” la IA)
    if (humanChats.has(socket.id)) return;

    // bot
    const { replies, notifyAgent, session, aiSignal, ui } = await handleText({
      chatId: socket.id,
      text,
    });

    replies.forEach((t) => {
      socket.emit("bot_message", { text: t });
      pushTranscript(socket.id, {
        who: "bot",
        text: t,
        ts: Date.now(),
        type: "text",
      });
      fanoutToAgentIfNeeded(socket.id, {
        who: "bot",
        text: t,
        ts: Date.now(),
        type: "text",
      });
    });

    if (ui?.cards?.length) {
      socket.emit("bot_message", { type: "property_cards", cards: ui.cards });
      pushTranscript(socket.id, {
        who: "bot",
        text: "[property_cards]",
        ts: Date.now(),
        type: "property_cards",
      });
    }

    // Programación / limpieza de timer IA según señal del engine
    if (aiSignal?.mode === "on" || aiSignal?.mode === "extend") {
      if (aiSignal.until) scheduleAIModeTimeout(socket.id, aiSignal.until);
    }
    if (aiSignal?.mode === "off") {
      clearAIModeTimer(socket.id);
    }

    // botones contextuales si aplica
    const buttons = buildButtonsForStep(session);
    if (buttons?.length) {
      const txt = "Elegí una opción:";
      socket.emit("bot_message", { text: txt, buttons });
      pushTranscript(socket.id, {
        who: "bot",
        text: txt,
        ts: Date.now(),
        type: "text",
      });
      fanoutToAgentIfNeeded(socket.id, {
        who: "bot",
        text: txt,
        ts: Date.now(),
        type: "text",
      });
    }

    // handoff: encolar para agente
    if (notifyAgent) {
      const rec = {
        chatId: socket.id,
        since: Date.now(),
        payload: notifyAgent,
      };
      addToQueue(rec, adminIo);

      const infoTxt = "📣 (Demo) Un agente fue notificado.";
      socket.emit("system_message", { text: infoTxt });
      pushTranscript(socket.id, {
        who: "system",
        text: infoTxt,
        ts: Date.now(),
        type: "text",
      });
      fanoutToAgentIfNeeded(socket.id, {
        who: "system",
        text: infoTxt,
        ts: Date.now(),
        type: "text",
      });
    }
  });

  // imagen del usuario
  socket.on("user_image", async (payload) => {
    console.log("este es el payload");
    try {
      console.log("Archivo recibido:", payload);
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
      // transcript + agente (si hay)
      pushTranscript(socket.id, { who: "user", url, type: "image", ts });
      fanoutToAgentIfNeeded(socket.id, { who: "user", url, type: "image", ts });

      // si está en modo humano, no invocamos al bot; sólo agradecemos
      if (humanChats.has(socket.id)) {
        const thanks = "📸 ¡Gracias por la imagen!";
        socket.emit("system_message", { text: thanks });
        pushTranscript(socket.id, {
          who: "system",
          text: thanks,
          ts: Date.now(),
        });
        fanoutToAgentIfNeeded(socket.id, {
          who: "system",
          text: thanks,
          ts: Date.now(),
        });
        return;
      }

      // flujo normal con bot
      const { replies, session } = await handleImage({
        chatId: socket.id,
        file: { url, type: type || "image/*", name: name || fname },
      });

      replies.forEach((t) => {
        socket.emit("bot_message", { text: t });
        pushTranscript(socket.id, { who: "bot", text: t, ts: Date.now() });
        fanoutToAgentIfNeeded(socket.id, {
          who: "bot",
          text: t,
          ts: Date.now(),
        });
      });

      const buttons = buildButtonsForStep(session);
      if (buttons?.length) {
        const txt = "Elegí una opción:";
        socket.emit("bot_message", { text: txt, buttons });
        pushTranscript(socket.id, { who: "bot", text: txt, ts: Date.now() });
        fanoutToAgentIfNeeded(socket.id, {
          who: "bot",
          text: txt,
          ts: Date.now(),
        });
      }

      // 🕒 Si está en modo IA, extender ventana por actividad con imagen
      const sNow = getSession(socket.id);
      if (sNow && sNow.step === "consultas_ia" && sNow.data?.ai?.active) {
        const until = engineTouchAI(socket.id);
        if (until) scheduleAIModeTimeout(socket.id, until);
      }
    } catch (e) {
      console.error("❌ Error guardando imagen:", e);
      socket.emit("system_message", { text: "⚠️ No pude procesar la imagen." });
      pushTranscript(socket.id, {
        who: "system",
        text: "⚠️ No pude procesar la imagen.",
        ts: Date.now(),
      });
    }
  });

  // 👇 NUEVO: el usuario finaliza
  socket.on("user_finish", () => endHumanChat(socket.id, "user", io, adminIo));

  // ⭐ Recepción de calificación u omisión
  socket.on("rate_submit", async ({ stars, skipped }) => {
    const txt = skipped
      ? "El usuario omitió la calificación."
      : `Puntaje recibido: ${Number(stars)}/5`;
    pushTranscript(socket.id, { who: "system", text: txt, ts: Date.now() });
    console.log("🎯 Rating:", { chatId: socket.id, stars, skipped });

    // Agradecer
    io.to(socket.id).emit("system_message", {
      text: skipped
        ? "Gracias. Tu opinión siempre suma. 🙏"
        : `¡Gracias por calificar con ${stars}★! 🙏`,
    });

    // Volver al menú principal del bot (invocamos el flujo con "menu")
    const { replies, session } = await handleText({
      chatId: socket.id,
      text: "menu",
    });
    replies.forEach((t) => io.to(socket.id).emit("bot_message", { text: t }));

    // Botones contextuales si aplica
    const buttons = buildButtonsForStep(session);
    if (buttons?.length) {
      io.to(socket.id).emit("bot_message", {
        text: "Elegí una opción:",
        buttons,
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 Cliente desconectado", socket.id);
    removeFromQueue(socket.id, adminIo);
    // 🧹 cortar timer IA si estaba activo
    clearAIModeTimer(socket.id);

    // si estaba con agente, avisar y limpiar
    if (humanChats.has(socket.id)) {
      const info = humanChats.get(socket.id);
      humanChats.delete(socket.id);
      adminIo.to(info.agentId).emit("chat_message", {
        chatId: socket.id,
        who: "system",
        text: "El usuario se desconectó.",
        ts: Date.now(),
      });
    }
  });
});

// Sirve el loader embebible
app.get("/widget.js", (req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "public", "widget.js"));
});

// Página “solo widget” (chat sin layout de web)
app.get("/widget", (req, res) => {
  res.render("widget", {
    COMPANY_NAME: process.env.COMPANY_NAME || "Tu Empresa",
    BOT_NAME: process.env.BOT_NAME || "Asistente",
    PRIMARY_COLOR: process.env.PRIMARY_COLOR || "#4f8cff",
  });
});

/* ====================== Start ====================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, "::", () => {
  console.log(`🌐 Web chat listo en http://localhost:${PORT}`);
  console.log(`🛠️  Panel admin: http://localhost:${PORT}/admin.html`);
  if (process.env.ADMIN_TOKEN) {
    console.log(`   (usar ?token=${process.env.ADMIN_TOKEN})`);
  }
});
