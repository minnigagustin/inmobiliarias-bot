// server.js — Web chat con Express + Socket.IO + Panel Admin (cola)
// Requisitos: Node 18+, dotenv, express, socket.io
// Opcional: .env con ADMIN_TOKEN para proteger /admin

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const { handleText, handleImage } = require("./engine");

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
    default:
      return null;
  }
}

/* ====================== Cola para el Panel Admin ====================== */
const pendingChats = new Map(); // chatId -> { chatId, since, payload }
function addToQueue(rec, adminIo) {
  pendingChats.set(rec.chatId, rec);
  adminIo.emit("queue_add", rec);
}
function removeFromQueue(chatId, adminIo) {
  if (pendingChats.delete(chatId)) {
    adminIo.emit("queue_remove", { chatId });
  }
}

/* ====================== Server & Sockets ====================== */
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Static web (public) y uploads
app.use(express.static(path.join(__dirname, "public")));
const uploadsDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir, { maxAge: "7d" }));

// Namespace para panel de agentes
const adminIo = io.of("/admin");

// (Opcional) auth por token simple
adminIo.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (process.env.ADMIN_TOKEN && token !== process.env.ADMIN_TOKEN) {
    return next(new Error("unauthorized"));
  }
  next();
});

// Conexión de agentes al panel
adminIo.on("connection", (socket) => {
  // Snapshot inicial de la cola
  socket.emit("queue_snapshot", Array.from(pendingChats.values()));

  // Un agente “toma” un chat
  socket.on("assign", ({ chatId, agent }) => {
    removeFromQueue(chatId, adminIo);
    io.to(chatId).emit("system_message", {
      text: `👤 ${agent || "Un agente"} tomó tu caso.`,
    });
    // (a futuro) mapear agent<->chat para chat en vivo
  });
});

// Conexión de usuarios al chat
io.on("connection", (socket) => {
  console.log("🟢 Cliente conectado", socket.id);

  socket.emit("bot_message", {
    text: '¡Hola! Soy el asistente BR-Group. Escribime lo que necesites (ej.: "se rompió la canilla").',
  });

  // Mensajes de texto del usuario
  socket.on("user_message", async (msg) => {
    const text = msg && msg.text ? String(msg.text) : "";
    const { replies, notifyAgent, session } = await handleText({
      chatId: socket.id,
      text,
    });

    // Respuestas del bot
    replies.forEach((t) => socket.emit("bot_message", { text: t }));

    // Botones contextuales si aplica
    const buttons = buildButtonsForStep(session);
    if (buttons?.length) {
      socket.emit("bot_message", { text: "Elegí una opción:", buttons });
    }

    // El flujo solicitó agente → encolamos para el panel
    if (notifyAgent) {
      const rec = {
        chatId: socket.id,
        since: Date.now(),
        payload: notifyAgent,
      };
      addToQueue(rec, adminIo);

      console.log("📣 Notificar a agente:", notifyAgent);
      socket.emit("system_message", {
        text: "📣 (Demo) Un agente fue notificado.",
      });
    }
  });

  // Imágenes del usuario
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

      const { replies, session } = await handleImage({
        chatId: socket.id,
        file: { url, type: type || "image/*", name: name || fname },
      });

      replies.forEach((t) => socket.emit("bot_message", { text: t }));

      // Botones si corresponde
      const buttons = buildButtonsForStep(session);
      if (buttons?.length) {
        socket.emit("bot_message", { text: "Elegí una opción:", buttons });
      }
    } catch (e) {
      console.error("❌ Error guardando imagen:", e);
      socket.emit("system_message", { text: "⚠️ No pude procesar la imagen." });
    }
  });

  // Desconexión del usuario
  socket.on("disconnect", () => {
    console.log("🔴 Cliente desconectado", socket.id);
    // Si estaba en cola, removerlo
    removeFromQueue(socket.id, adminIo);
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
