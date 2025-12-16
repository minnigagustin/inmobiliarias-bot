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
    origin: (origin, cb) => {
      // origin es p.ej. "https://br-group.com.ar" en el celu
      const allow = new Set([
        "https://br-group.com.ar",
        "https://www.br-group.com.ar",

        // si también lo abrís directo en backpack:
        "https://backpackpuntaalta.ar",
        "https://www.backpackpuntaalta.ar",

        // para tests locales
        "http://localhost",
        "http://localhost:3000",

        // algunos webviews envían null/undefined
        undefined,
        null,
      ]);
      cb(null, allow.has(origin));
    },
    methods: ["GET", "POST"],
    credentials: true,
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
app.use("/uploads", express.static(uploadsDir, { maxAge: "7d" }));

app.get("/qr-code", async (req, res) => {
  const { qr, ready } = qrStore.get();

  // (Opcional) proteger con token simple
  // if (process.env.ADMIN_TOKEN && req.query.token !== process.env.ADMIN_TOKEN) {
  //   return res.status(401).send("unauthorized");
  // }

  if (ready) {
    return res.send("<h2>✅ WhatsApp ya está conectado.</h2>");
  }

  if (!qr) {
    // No hay QR todavía: refrescá cada 2s
    return res.send(`
      <h2>⏳ Esperando QR…</h2>
      <script>setTimeout(()=>location.reload(), 2000)</script>
    `);
  }

  const dataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 8 });

  res.send(`
    <h2>Escaneá el QR de WhatsApp</h2>
    <img src="${dataUrl}" style="max-width:360px; width:100%; height:auto;" />
    <p>Se actualiza solo si cambia.</p>
    <script>setTimeout(()=>location.reload(), 5000)</script>
  `);
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
    const { replies, notifyAgent, session, aiSignal } = await handleText({
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

/* ====================== Start ====================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, "::", () => {
  console.log(`🌐 Web chat listo en http://localhost:${PORT}`);
  console.log(`🛠️  Panel admin: http://localhost:${PORT}/admin.html`);
  if (process.env.ADMIN_TOKEN) {
    console.log(`   (usar ?token=${process.env.ADMIN_TOKEN})`);
  }
});
