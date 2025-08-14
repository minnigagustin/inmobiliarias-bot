// index.js — WhatsApp (whatsapp-web.js) con guardado de fotos + BRIDGE omnicanal
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { handleText, handleImage } = require("./engine");

// ===== Bridge (socket.io-client) para integrarse con server.js (/bridge) =====
const { io } = require("socket.io-client");
const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:3000/bridge";
const bridge = io(BRIDGE_URL, { transports: ["websocket"] });

// Chats de WhatsApp en modo humano (tomados por un agente en el panel)
const humanMode = new Set();
// JIDs ya registrados en el bridge
const registered = new Set();

// Helpers Bridge
function bridgeRegisterIfNeeded(chatId) {
  if (!registered.has(chatId)) {
    bridge.emit("register_chat", { chatId });
    registered.add(chatId);
  }
}
function pushTx(chatId, msg) {
  // msg: { who: "user"|"bot"|"system"|"agent", text?, url?, type, ts }
  bridge.emit("push_transcript", { chatId, msg });
}

// Eventos del bridge
bridge.on("connect", () => console.log("🔗 Bridge conectado:", BRIDGE_URL));
bridge.on("connect_error", (e) =>
  console.error("❌ Bridge error:", e?.message || e)
);
bridge.on("disconnect", () => console.log("🔌 Bridge desconectado"));

// Orden desde el panel: un agente tomó el caso
bridge.on("agent_assigned", async ({ chatId, agent }) => {
  humanMode.add(chatId);
  pushTx(chatId, {
    who: "system",
    type: "text",
    text: `Agente asignado: ${agent || "Agente"}`,
    ts: Date.now(),
  });
  try {
    await client.sendMessage(
      chatId,
      `👤 ${agent || "Un agente"} tomó tu caso.`
    );
  } catch (_) {}
});

// Orden desde el panel: entregar mensaje del agente al usuario de WhatsApp
bridge.on("deliver_to_user", async ({ chatId, text }) => {
  if (!chatId || !text) return;
  try {
    await client.sendMessage(chatId, text);
  } catch (e) {
    console.error("❌ Error deliver_to_user:", e?.message || e);
  }
});

// Orden desde el panel: finalizar conversación humana
bridge.on("finish", async ({ chatId }) => {
  humanMode.delete(chatId);
  pushTx(chatId, {
    who: "system",
    type: "text",
    text: "Conversación finalizada por el agente.",
    ts: Date.now(),
  });
  try {
    await client.sendMessage(
      chatId,
      "✅ El agente finalizó la conversación. Volvemos al asistente."
    );
  } catch (_) {}
});

// ===== WhatsApp config =====
const AGENT_NUMBER = process.env.AGENT_NUMBER || ""; // 54911XXXXXXXX (sin +, opcional)
const AGENT_JID = AGENT_NUMBER ? `${AGENT_NUMBER}@c.us` : null;

// Carpeta de uploads (compartida con el server web)
const uploadsDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Ext por mimetype
function extFromMime(m) {
  if (!m) return "bin";
  if (m.includes("jpeg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("pdf")) return "pdf";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("wav")) return "wav";
  if (m.includes("mp3")) return "mp3";
  return m.split("/")[1] || "bin";
}

// Guarda base64 en disco y devuelve { url, type, name, filePath }
function persistMediaToDisk(media) {
  const ext = extFromMime(media.mimetype);
  const name =
    media.filename ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const filePath = path.join(uploadsDir, name);
  fs.writeFileSync(filePath, Buffer.from(media.data, "base64"));
  const url = `/uploads/${name}`;
  return {
    url,
    type: media.mimetype || "application/octet-stream",
    name,
    filePath,
  };
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "brgroup-nlu" }), // persiste sesión en .wwebjs_auth
  puppeteer: {
    headless: true, // 👈 obligatorio en server
    args: [
      "--no-sandbox", // necesarios en muchos servidores
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", // evita /dev/shm pequeño
      "--disable-gpu",
      "--no-zygote",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-breakpad",
      "--disable-component-update",
      "--disable-features=site-per-process,TranslateUI,BlinkGenPropertyTrees",
      "--disable-ipc-flooding-protection",
      "--disable-renderer-backgrounding",
      "--enable-features=NetworkService",
      "--force-color-profile=srgb",
    ],
    // opcional: tiempo de arranque más laxo
    timeout: 0,
  },
});
client.on("qr", (qr) => qrcode.generate(qr, { small: true }));
client.on("ready", () => console.log("✅ WhatsApp listo"));

/** Cache de media por chat para reenviarlas al agente por WhatsApp (opcional) */
const mediaCache = new Map(); // Map<chatId, Array<MessageMedia>>
function pushMedia(chatId, media) {
  if (!mediaCache.has(chatId)) mediaCache.set(chatId, []);
  const arr = mediaCache.get(chatId);
  arr.push(media);
  if (arr.length > 10) arr.shift(); // límite
}
function clearMedia(chatId) {
  mediaCache.delete(chatId);
}

client.on("message", async (msg) => {
  const chatId = msg.from; // JID 54911xxxxxxx@c.us
  bridgeRegisterIfNeeded(chatId);

  const ts = Date.now();
  const bodyRaw = (msg.body || "").trim();

  // Si está en modo humano, NO invocamos al bot; solo transcript hacia el panel
  if (humanMode.has(chatId)) {
    try {
      if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        const saved = persistMediaToDisk(media);
        pushTx(chatId, { who: "user", url: saved.url, type: "image", ts });
        await client.sendMessage(chatId, "📸 ¡Imagen recibida!");
      } else {
        pushTx(chatId, { who: "user", text: bodyRaw, type: "text", ts });
      }
    } catch (e) {
      console.error("❌ error en modo humano:", e?.message || e);
    }
    return; // bloquea al bot mientras hay agente
  }

  try {
    const chat = await msg.getChat();
    try {
      await chat.sendSeen();
    } catch (_) {}
    try {
      await chat.sendStateTyping();
    } catch (_) {}

    // ===== 1) Mensajes con MEDIA =====
    if (msg.hasMedia) {
      const media = await msg.downloadMedia(); // { data(base64), mimetype, filename? }
      const saved = persistMediaToDisk(media); // URL pública
      // Transcript del usuario (imagen)
      pushTx(chatId, { who: "user", type: "image", url: saved.url, ts });

      // Guardar también para reenviar por WhatsApp si se deriva
      pushMedia(chatId, media);

      // Pasamos al engine con URL real
      const { replies } = await handleImage({
        chatId,
        file: { url: saved.url, type: saved.type, name: saved.name },
      });

      for (const t of replies) {
        await client.sendMessage(chatId, t);
        pushTx(chatId, {
          who: "bot",
          type: "text",
          text: t,
          ts: Date.now(),
        });
      }

      // Si vino con caption, lo tratamos como mensaje de texto adicional
      if (bodyRaw) {
        // transcript del caption como texto del user
        pushTx(chatId, {
          who: "user",
          type: "text",
          text: bodyRaw,
          ts: Date.now(),
        });

        const res2 = await handleText({ chatId, text: bodyRaw });
        for (const t of res2.replies) {
          await client.sendMessage(chatId, t);
          pushTx(chatId, {
            who: "bot",
            type: "text",
            text: t,
            ts: Date.now(),
          });
        }

        // Si se derivó a agente → ENCOLAR en el panel (bridge)
        if (res2.notifyAgent) {
          bridge.emit("enqueue", {
            chatId,
            since: Date.now(),
            payload: res2.notifyAgent, // {categoria, direccion, descripcion, fotos(urls), ...}
          });
          // Mensaje informativo al usuario
          const infoTxt = "📣 (Demo) Un agente fue notificado.";
          await client.sendMessage(chatId, infoTxt);
          pushTx(chatId, {
            who: "system",
            type: "text",
            text: "Caso encolado desde WhatsApp.",
            ts: Date.now(),
          });
        }

        // Si el engine reinició, limpiamos cache de fotos
        if (res2.session && res2.session.step === "start") clearMedia(chatId);
      }

      try {
        await chat.clearState();
      } catch (_) {}
      return; // no seguir con texto
    }

    // ===== 2) Mensajes de TEXTO =====
    // Transcript del usuario (texto)
    pushTx(chatId, { who: "user", type: "text", text: bodyRaw, ts });

    const result = await handleText({ chatId, text: bodyRaw });
    const { replies, notifyAgent, session } = result;

    for (const t of replies) {
      await client.sendMessage(chatId, t);
      pushTx(chatId, { who: "bot", type: "text", text: t, ts: Date.now() });
    }

    // Handoff: encolar para panel admin (bridge)
    if (notifyAgent) {
      bridge.emit("enqueue", {
        chatId,
        since: Date.now(),
        payload: notifyAgent,
      });

      const infoTxt = "📣 (Demo) Un agente fue notificado.";
      await client.sendMessage(chatId, infoTxt);
      pushTx(chatId, {
        who: "system",
        type: "text",
        text: "Caso encolado desde WhatsApp.",
        ts: Date.now(),
      });
    }

    // (Opcional) También reenviar al AGENT_JID por WhatsApp si definiste AGENT_NUMBER
    if (notifyAgent && AGENT_JID) {
      const pics = mediaCache.get(chatId);
      const lines = [
        "📣 *Derivación desde el bot*",
        `👤 Usuario: ${chatId}`,
        notifyAgent.motivo ? `🧩 Motivo: ${notifyAgent.motivo}` : null,
        notifyAgent.categoria ? `🔧 Categoría: ${notifyAgent.categoria}` : null,
        notifyAgent.direccion ? `📍 Dirección: ${notifyAgent.direccion}` : null,
        notifyAgent.descripcion
          ? `📝 Descripción: ${notifyAgent.descripcion}`
          : null,
        notifyAgent.indice ? `📊 Índice: ${notifyAgent.indice}` : null,
        notifyAgent.calculo ? `🧮 Cálculo: ${notifyAgent.calculo}` : null,
        notifyAgent.propform
          ? `🏷️ Propiedad: ${JSON.stringify(notifyAgent.propform)}`
          : null,
        pics && pics.length ? `📷 Fotos adjuntas: ${pics.length}` : null,
      ].filter(Boolean);

      try {
        await client.sendMessage(AGENT_JID, lines.join("\n"));
        if (pics && pics.length) {
          for (let i = 0; i < pics.length; i++) {
            const m = pics[i];
            const mm = new MessageMedia(
              m.mimetype,
              m.data,
              m.filename || `adjunto-${i + 1}`
            );
            await client.sendMessage(AGENT_JID, mm, {
              caption: `📷 ${i + 1}/${pics.length} de ${chatId}`,
            });
          }
          clearMedia(chatId);
        }
      } catch (e) {
        console.error("❌ Error enviando al AGENT_JID:", e?.message || e);
      }
    }

    // Si el engine reseteó el flujo (volvió a start), limpiamos media cache
    if (session && session.step === "start") clearMedia(chatId);

    try {
      await chat.clearState();
    } catch (_) {}
  } catch (e) {
    console.error(e);
    try {
      await client.sendMessage(
        chatId,
        '⚠️ Ocurrió un error. Escribí "menu" para reiniciar.'
      );
    } catch (_) {}
  }
});

client.initialize();
