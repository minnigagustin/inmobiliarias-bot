// server.js — Web chat + botones + Panel Admin con handoff en vivo
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const { handleText, handleImage, reset } = require("./engine");

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
        { label: "5. Hablar con un humano", value: "5" },
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
    case "rep_fotos_preg": // 👈 NUEVO
      return [
        { label: "Sí", value: "sí" },
        { label: "No", value: "no" },
      ];
    default:
      return null;
  }
}

/* ====================== Cola + handoff + transcript ====================== */
const pendingChats = new Map(); // chatId -> { chatId, since, payload }
const conversations = new Map(); // chatId -> [{who, text?, url?, type, ts}]
const humanChats = new Map(); // chatId -> { agentId, agentName }

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

/* ====================== Server & Sockets ====================== */
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
const uploadsDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir, { maxAge: "7d" }));

const adminIo = io.of("/admin");

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
  io.to(chatId).emit("agent_finished", {}); // 👈 evento para que el cliente salga de modo humano
  pushTranscript(chatId, { who: "system", text: msgUser, ts: Date.now() });

  // Aviso del otro lado
  adminIo.to(info.agentId).emit("chat_message", {
    chatId,
    who: "system",
    text:
      who === "agent"
        ? "Conversación finalizada por el agente."
        : "Conversación finalizada por el usuario.",
    ts: Date.now(),
  });

  // Reseteamos flujo del bot
  reset(chatId);
}

/* ===== Panel de agentes ===== */
adminIo.on("connection", (socket) => {
  // Snapshot inicial de la cola
  socket.emit("queue_snapshot", Array.from(pendingChats.values()));

  // Asignación de un chat al agente
  socket.on("assign", ({ chatId, agent }) => {
    // 👇 Tomo el registro ANTES de removerlo de la cola
    const rec = pendingChats.get(chatId) || null;
    const payload = rec?.payload || null;

    removeFromQueue(chatId, adminIo);
    humanChats.set(chatId, {
      agentId: socket.id,
      agentName: agent || "Agente",
    });

    const transcript = conversations.get(chatId) || [];
    // 👇 ahora enviamos también `payload`
    socket.emit("assigned", { chatId, transcript, payload });

    io.to(chatId).emit("system_message", {
      text: `👤 ${agent || "Un agente"} tomó tu caso.`,
    });
    io.to(chatId).emit("agent_assigned", { agent: agent || "Agente" });

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
    // eco al propio agente (por si hay varios)
    fanoutToAgentIfNeeded(chatId, { who: "agent", text, ts, type: "text" });
  });

  // 👇 NUEVO: el agente finaliza
  socket.on("finish", ({ chatId }) =>
    endHumanChat(chatId, "agent", io, adminIo)
  );

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
        // (opcional) resetear FSM del bot para empezar limpio
        reset(chatId);
      }
    }
  });
});

/* ===== Usuarios del chat ===== */
io.on("connection", (socket) => {
  console.log("🟢 Cliente conectado", socket.id);

  // bienvenida
  const hello =
    '¡Hola! Soy el asistente BR-Group. Escribime lo que necesites (ej.: "se rompió la canilla").';
  socket.emit("bot_message", { text: hello });
  pushTranscript(socket.id, {
    who: "bot",
    text: hello,
    ts: Date.now(),
    type: "text",
  });

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
    const { replies, notifyAgent, session } = await handleText({
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

  socket.on("disconnect", () => {
    console.log("🔴 Cliente desconectado", socket.id);
    removeFromQueue(socket.id, adminIo);

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
server.listen(PORT, () => {
  console.log(`🌐 Web chat listo en http://localhost:${PORT}`);
  console.log(`🛠️  Panel admin: http://localhost:${PORT}/admin.html`);
  if (process.env.ADMIN_TOKEN) {
    console.log(`   (usar ?token=${process.env.ADMIN_TOKEN})`);
  }
});
