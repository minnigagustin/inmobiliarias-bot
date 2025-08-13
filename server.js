// server.js — Web chat con Express + Socket.IO usando el engine común
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const { handleText, handleImage } = require("./engine");

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
    const { replies, notifyAgent } = await handleText({
      chatId: socket.id,
      text,
    });
    replies.forEach((t) => socket.emit("bot_message", { text: t }));

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

      // Pasar al engine para que reaccione según el paso
      const { replies } = await handleImage({
        chatId: socket.id,
        file: { url, type: type || "image/*", name: name || fname },
      });

      replies.forEach((t) => socket.emit("bot_message", { text: t }));
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
