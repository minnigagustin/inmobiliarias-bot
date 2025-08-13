// server.js — Web chat con Express + Socket.IO usando el engine común
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const { handleText, handleImage } = require("./engine");

// Helper: construir botones según el paso actual del flujo
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
      // Acepta números 1–5 en tu FSM
      return [
        { label: "1. Plomería", value: "1" },
        { label: "2. Gas", value: "2" },
        { label: "3. Electricidad", value: "3" },
        { label: "4. Artefacto roto", value: "4" },
        { label: "5. Otro", value: "5" },
      ];

    case "indices_menu":
      // Atajos de texto que ya reconoce tu NLU/reglas
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

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// static
app.use(express.static(path.join(__dirname, "public")));
const uploadsDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir, { maxAge: "7d" }));

io.on("connection", (socket) => {
  console.log("🟢 Cliente conectado", socket.id);
  socket.emit("bot_message", {
    text: '¡Hola! Soy el asistente BR-Group. Escribime lo que necesites (ej.: "se rompió la canilla").',
  });

  socket.on("user_message", async (msg) => {
    const text = msg && msg.text ? String(msg.text) : "";
    const { replies, notifyAgent, session } = await handleText({
      chatId: socket.id,
      text,
    });

    replies.forEach((t) => socket.emit("bot_message", { text: t }));

    // ▶️ Botones contextuales
    const buttons = buildButtonsForStep(session);
    if (buttons?.length) {
      socket.emit("bot_message", {
        text: "Elegí una opción:",
        buttons,
      });
    }

    if (notifyAgent) {
      console.log("📣 Notificar a agente:", notifyAgent);
      socket.emit("system_message", {
        text: "📣 (Demo) Un agente fue notificado.",
      });
    }
  });

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

      // ▶️ Si tras subir foto seguimos en un paso con opciones, mostrarlas
      const buttons = buildButtonsForStep(session);
      if (buttons?.length) {
        socket.emit("bot_message", {
          text: "Elegí una opción:",
          buttons,
        });
      }
    } catch (e) {
      console.error("❌ Error guardando imagen:", e);
      socket.emit("system_message", { text: "⚠️ No pude procesar la imagen." });
    }
  });

  socket.on("disconnect", () =>
    console.log("🔴 Cliente desconectado", socket.id)
  );
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🌐 Web chat listo en http://localhost:${PORT}`)
);
