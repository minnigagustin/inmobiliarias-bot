// index.js — WhatsApp (whatsapp-web.js) con guardado de fotos + BRIDGE omnicanal
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const qrStore = require("./wa-qr-store");
require("dotenv").config();

const {
  handleText,
  handleImage,
  getSession,
  engineExitAI,
  engineTouchAI,
} = require("./engine");

// ===== Bridge (socket.io-client) para integrarse con server.js (/bridge) =====
const { io } = require("socket.io-client");
const BRIDGE_URL =
  process.env.BRIDGE_URL || "https://backpackpuntaalta.ar:443/bridge";
const bridge = io(BRIDGE_URL, { transports: ["websocket"] });

// Chats de WhatsApp en modo humano (tomados por un agente en el panel)
const humanMode = new Set();
// JIDs ya registrados en el bridge
const registered = new Set();
const aiTimersWA = new Map(); // chatId -> timeoutId

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

function clearAIModeTimerWA(chatId) {
  const t = aiTimersWA.get(chatId);
  if (t) {
    clearTimeout(t);
    aiTimersWA.delete(chatId);
  }
}
function scheduleAIModeTimeoutWA(chatId, untilTs) {
  clearAIModeTimerWA(chatId);
  const delay = Math.max(0, untilTs - Date.now());
  const t = setTimeout(async () => {
    // si está en modo humano, no avisamos
    if (humanMode.has(chatId)) return clearAIModeTimerWA(chatId);

    const s = getSession(chatId);
    const stillAI = s && s.step === "consultas_ia" && s.data?.ai?.active;
    if (!stillAI) return clearAIModeTimerWA(chatId);

    engineExitAI(chatId);
    const text =
      "⏱️ Cerramos el modo consulta por inactividad. Escribí *menu* para volver.";
    try {
      await client.sendMessage(chatId, text);
    } catch (_) {}
    // Transcript al panel
    pushTx(chatId, { who: "system", type: "text", text, ts: Date.now() });
    clearAIModeTimerWA(chatId);
  }, delay);
  aiTimersWA.set(chatId, t);
}

// Eventos del bridge
let bridgeConnected = false;

bridge.on("connect", () => {
  console.log("🔗 Bridge conectado:", BRIDGE_URL);
  bridgeConnected = true;
  // Send current status when bridge connects/reconnects
  const currentStatus = qrStore.get();
  emitWaStatus(currentStatus);
});
bridge.on("connect_error", (e) => {
  console.error("❌ Bridge error:", e?.message || e);
  bridgeConnected = false;
});
bridge.on("disconnect", () => {
  console.log("🔌 Bridge desconectado");
  bridgeConnected = false;
});

// Helper to safely emit wa_status
function emitWaStatus(data) {
  // Emit to bridge if connected
  if (bridgeConnected) {
    bridge.emit("wa_status", data);
    console.log("📤 wa_status emitido:", data.status);
  } else {
    console.log("⚠️ Bridge no conectado, estado guardado localmente:", data.status);
  }
}

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
    clearAIModeTimerWA(chatId);
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

// Orden desde el panel: entregar imagen del agente al usuario de WhatsApp
bridge.on("deliver_image_to_user", async ({ chatId, url, filePath }) => {
  if (!chatId) return;
  try {
    let media;
    if (filePath && fs.existsSync(filePath)) {
      media = MessageMedia.fromFilePath(filePath);
    } else if (url) {
      const absPath = path.join(__dirname, "public", url);
      if (fs.existsSync(absPath)) {
        media = MessageMedia.fromFilePath(absPath);
      }
    }
    if (media) {
      await client.sendMessage(chatId, media);
    }
  } catch (e) {
    console.error("❌ Error deliver_image_to_user:", e?.message || e);
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
    clearAIModeTimerWA(chatId);
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
// Set initializing status on startup
qrStore.setInitializing();

client.on("qr", (qr) => {
  qrStore.setQR(qr);
  // Emit wa_status event to bridge for super-admin
  emitWaStatus({ status: "qr_pending", qr });
  // si querés seguir mostrando en consola:
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  console.log("🔐 WhatsApp autenticado - esperando evento 'ready'...");
  // Status intermedio entre QR escaneado y listo
  qrStore.setStatus("authenticated");
  emitWaStatus({ status: "authenticated" });

  // Workaround: Si 'ready' no llega en 30 segundos, verificamos manualmente
  setTimeout(async () => {
    const currentState = qrStore.get();
    if (currentState.status === "authenticated") {
      console.log("⚠️ 'ready' no recibido después de 30s, verificando estado manualmente...");
      try {
        // Intentar obtener info del cliente para verificar si está listo
        const state = await client.getState();
        console.log("📱 Estado del cliente:", state);
        if (state === "CONNECTED") {
          console.log("✅ Cliente conectado (detectado manualmente)");
          qrStore.setReady();
          emitWaStatus({ status: "ready" });
        }
      } catch (e) {
        console.log("⚠️ No se pudo verificar estado:", e.message);
      }
    }
  }, 30000);
});

// Add loading_screen event for debugging
client.on("loading_screen", (percent, message) => {
  console.log(`📱 WhatsApp cargando: ${percent}% - ${message}`);
});

// Add change_state event for debugging
client.on("change_state", (state) => {
  console.log(`📱 WhatsApp cambio de estado: ${state}`);
  // Si el estado cambia a CONNECTED y aún no estamos en "ready", actualizar
  if (state === "CONNECTED") {
    const currentStatus = qrStore.get();
    if (currentStatus.status !== "ready") {
      console.log("✅ Detectado CONNECTED via change_state");
      qrStore.setReady();
      emitWaStatus({ status: "ready" });
    }
  }
});

client.on("ready", () => {
  console.log("✅ WhatsApp listo - actualizando estado...");
  qrStore.setReady();
  console.log("✅ Estado actualizado en archivo");
  // Emit wa_status event to bridge for super-admin
  console.log("✅ Bridge conectado?", bridgeConnected);
  emitWaStatus({ status: "ready" });
  console.log("✅ Evento wa_status emitido");
  // Reset reconnect attempts on successful connection
  reconnectAttempts = 0;
});

// 🛡️ Robust Reconnection with Exponential Backoff
const RECONNECT_CONFIG = {
  maxAttempts: 5,
  baseDelay: 5000, // 5 seconds
  maxDelay: 60000, // 60 seconds max
};
let reconnectAttempts = 0;
let reconnectTimeout = null;

async function attemptReconnect() {
  if (reconnectAttempts >= RECONNECT_CONFIG.maxAttempts) {
    console.error("❌ Máximo de intentos de reconexión alcanzado. Reinicia el proceso manualmente.");
    qrStore.setStatus("reconnect_failed");
    emitWaStatus({ status: "reconnect_failed", attempts: reconnectAttempts });
    return;
  }

  reconnectAttempts++;
  const delay = Math.min(
    RECONNECT_CONFIG.baseDelay * Math.pow(2, reconnectAttempts - 1),
    RECONNECT_CONFIG.maxDelay
  );

  console.log(`🔄 Intentando reconexión ${reconnectAttempts}/${RECONNECT_CONFIG.maxAttempts} en ${delay / 1000}s...`);
  qrStore.setStatus("reconnecting");
  emitWaStatus({ status: "reconnecting", attempt: reconnectAttempts, nextAttemptIn: delay });

  reconnectTimeout = setTimeout(async () => {
    try {
      // Try to destroy existing client first
      try {
        await client.destroy();
        console.log("🗑️ Cliente anterior destruido");
      } catch (destroyErr) {
        // Ignore destroy errors
      }

      // Small delay before reinitializing
      await new Promise(resolve => setTimeout(resolve, 2000));

      await client.initialize();
      reconnectAttempts = 0; // Reset on success
      console.log("✅ Reconexión exitosa");
    } catch (err) {
      console.error("❌ Error en reconexión:", err.message);
      attemptReconnect();
    }
  }, delay);
}

function cancelReconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  reconnectAttempts = 0;
}

client.on("disconnected", (reason) => {
  qrStore.setDisconnected();
  // Emit wa_status event to bridge for super-admin
  emitWaStatus({ status: "disconnected", reason });
  console.log("🔌 WhatsApp desconectado:", reason);

  // Attempt reconnection
  if (reason !== "LOGOUT") {
    attemptReconnect();
  }
});

client.on("auth_failure", (msg) => {
  qrStore.setAuthFailure();
  // Emit wa_status event to bridge for super-admin
  emitWaStatus({ status: "auth_failure", message: msg });
  console.log("❌ Error de autenticación WhatsApp:", msg);
  // Don't auto-reconnect on auth failure - requires QR scan
});

// Add error event for debugging
client.on("remote_session_saved", () => {
  console.log("💾 Sesión remota guardada");
});

// Listen for any errors from puppeteer
client.pupPage?.on("error", (err) => {
  console.error("❌ Puppeteer page error:", err);
});

client.pupPage?.on("pageerror", (err) => {
  console.error("❌ Puppeteer page JS error:", err);
});

/** Cache de media por chat para reenviarlas al agente por WhatsApp (opcional) */
const mediaCache = new Map(); // Map<chatId, Array<MessageMedia>>
const MEDIA_CACHE_MAX_CHATS = 50; // 🛡️ Límite máximo de chats en cache
const MEDIA_CACHE_MAX_PER_CHAT = 10; // Máximo de media por chat

function pushMedia(chatId, media) {
  // 🛡️ LRU Eviction: Si alcanzamos el límite, eliminamos el chat más antiguo
  if (!mediaCache.has(chatId) && mediaCache.size >= MEDIA_CACHE_MAX_CHATS) {
    const oldestChatId = mediaCache.keys().next().value;
    mediaCache.delete(oldestChatId);
    console.log(`🗑️ Media cache LRU: eliminado chat ${oldestChatId}`);
  }

  if (!mediaCache.has(chatId)) mediaCache.set(chatId, []);
  const arr = mediaCache.get(chatId);
  arr.push(media);
  if (arr.length > MEDIA_CACHE_MAX_PER_CHAT) arr.shift(); // límite por chat

  // Mover el chat al final (más reciente) para LRU
  mediaCache.delete(chatId);
  mediaCache.set(chatId, arr);
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

      const sNow = getSession(chatId);
      if (sNow && sNow.step === "consultas_ia" && sNow.data?.ai?.active) {
        const until = engineTouchAI(chatId);
        if (until) scheduleAIModeTimeoutWA(chatId, until);
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

        const {
          replies: replies2,
          notifyAgent: notifyAgent2,
          session: session2,
          aiSignal: aiSignal2,
        } = await handleText({ chatId, text: bodyRaw });

        for (const t of replies2) {
          await client.sendMessage(chatId, t);
          pushTx(chatId, { who: "bot", type: "text", text: t, ts: Date.now() });
        }

        // Programación / limpieza de timer IA (para caption)
        if (aiSignal2?.mode === "on" || aiSignal2?.mode === "extend") {
          if (aiSignal2.until) scheduleAIModeTimeoutWA(chatId, aiSignal2.until);
        }
        if (aiSignal2?.mode === "off") {
          clearAIModeTimerWA(chatId);
        }

        // Si se derivó a agente → ENCOLAR en el panel (bridge)
        if (notifyAgent2) {
          bridge.emit("enqueue", {
            chatId,
            since: Date.now(),
            payload: notifyAgent2,
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

        // Si el engine reinició, limpiamos cache de fotos y apagamos timer IA
        if (session2 && session2.step === "start") {
          clearMedia(chatId);
          clearAIModeTimerWA(chatId);
        }
      }

      try {
        await chat.clearState();
      } catch (_) {}
      return; // no seguir con texto
    }

    // ===== 2) Mensajes de TEXTO =====
    // Transcript del usuario (texto)
    pushTx(chatId, { who: "user", type: "text", text: bodyRaw, ts });

    const { replies, notifyAgent, session, aiSignal } = await handleText({
      chatId,
      text: bodyRaw,
    });

    for (const t of replies) {
      await client.sendMessage(chatId, t);
      pushTx(chatId, { who: "bot", type: "text", text: t, ts: Date.now() });
    }

    // Programación / limpieza de timer IA
    if (aiSignal?.mode === "on" || aiSignal?.mode === "extend") {
      if (aiSignal.until) scheduleAIModeTimeoutWA(chatId, aiSignal.until);
    }
    if (aiSignal?.mode === "off") {
      clearAIModeTimerWA(chatId);
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
    // Si el engine reseteó el flujo (volvió a start), limpiamos media cache y timer IA
    if (session && session.step === "start") {
      clearMedia(chatId);
      clearAIModeTimerWA(chatId);
    }
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

// Graceful initialization with error handling
async function initializeWhatsApp() {
  try {
    console.log("🚀 Iniciando cliente WhatsApp...");
    await client.initialize();
  } catch (err) {
    console.error("❌ Error inicializando WhatsApp:", err.message);

    // Check if it's a session corruption issue
    if (err.message.includes("Execution context was destroyed") ||
        err.message.includes("Session closed") ||
        err.message.includes("Target closed")) {
      console.log("⚠️ Posible sesión corrupta. Intentando reconexión...");
      qrStore.setDisconnected();
      emitWaStatus({ status: "error", message: err.message });

      // Attempt reconnection after delay
      setTimeout(() => {
        attemptReconnect();
      }, 5000);
    } else {
      // For other errors, just log and try to reconnect
      qrStore.setStatus("error");
      emitWaStatus({ status: "error", message: err.message });
      attemptReconnect();
    }
  }
}

// Handle unhandled rejections from Puppeteer
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection:', reason);
  // Don't exit - let the reconnection logic handle it
});

// Start WhatsApp client
initializeWhatsApp();
