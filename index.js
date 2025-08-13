// index.js — WhatsApp (whatsapp-web.js) reutilizando el engine con fotos + typing + caption
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
require("dotenv").config();

const { handleText, handleImage } = require("./engine");

const AGENT_NUMBER = process.env.AGENT_NUMBER || ""; // 54911XXXXXXXX (sin +)
const AGENT_JID = AGENT_NUMBER ? `${AGENT_NUMBER}@c.us` : null;

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "brgroup-nlu" }),
  puppeteer: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
});

client.on("qr", (qr) => qrcode.generate(qr, { small: true }));
client.on("ready", () => console.log("✅ WhatsApp listo"));

/** Cache de media por chat para reenviarlas al agente si se deriva */
const mediaCache = new Map(); // Map<chatId, Array<MessageMedia>>
function pushMedia(chatId, media) {
  if (!mediaCache.has(chatId)) mediaCache.set(chatId, []);
  const arr = mediaCache.get(chatId);
  arr.push(media);
  // límite de seguridad para no crecer sin control
  if (arr.length > 10) arr.shift();
}
function clearMedia(chatId) {
  mediaCache.delete(chatId);
}
function takeMedia(chatId) {
  const arr = mediaCache.get(chatId) || [];
  clearMedia(chatId);
  return arr;
}

client.on("message", async (msg) => {
  const chatId = msg.from;
  const bodyRaw = (msg.body || "").trim();

  try {
    const chat = await msg.getChat();
    // Opcional: marcar como visto y mostrar "escribiendo…" mientras procesamos
    try {
      await chat.sendSeen();
    } catch (_) {}
    try {
      await chat.sendStateTyping();
    } catch (_) {}

    // ===== 1) Mensajes con MEDIA =====
    if (msg.hasMedia) {
      const media = await msg.downloadMedia(); // { data: base64, mimetype, filename? }
      pushMedia(chatId, media);

      // Pasamos al engine para sumar la foto al flujo
      const { replies } = await handleImage({
        chatId,
        file: {
          url: `wa://${media.mimetype}`, // marcador simbólico (no hace falta URL real)
          type: media.mimetype || "image/*",
          name: media.filename || "archivo",
        },
      });

      for (const t of replies) {
        await client.sendMessage(chatId, t);
      }

      // Si vino con caption, procesarlo como texto también (sirve para la descripción)
      if (bodyRaw) {
        const res2 = await handleText({ chatId, text: bodyRaw });
        for (const t of res2.replies) await client.sendMessage(chatId, t);

        // Si se derivó a agente, reenviar las fotos acumuladas y limpiar cache
        if (res2.notifyAgent && AGENT_JID) {
          const pics = mediaCache.get(chatId);
          const lines = [
            "📣 *Derivación desde el bot*",
            `👤 Usuario: ${chatId}`,
            res2.notifyAgent.motivo
              ? `🧩 Motivo: ${res2.notifyAgent.motivo}`
              : null,
            res2.notifyAgent.categoria
              ? `🔧 Categoría: ${res2.notifyAgent.categoria}`
              : null,
            res2.notifyAgent.direccion
              ? `📍 Dirección: ${res2.notifyAgent.direccion}`
              : null,
            res2.notifyAgent.descripcion
              ? `📝 Descripción: ${res2.notifyAgent.descripcion}`
              : null,
            res2.notifyAgent.indice
              ? `📊 Índice: ${res2.notifyAgent.indice}`
              : null,
            res2.notifyAgent.calculo
              ? `🧮 Cálculo: ${res2.notifyAgent.calculo}`
              : null,
            res2.notifyAgent.propform
              ? `🏷️ Propiedad: ${JSON.stringify(res2.notifyAgent.propform)}`
              : null,
            pics && pics.length ? `📷 Fotos adjuntas: ${pics.length}` : null,
          ].filter(Boolean);
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
        }

        // Si el engine reinició el flujo, limpiamos cache de fotos
        if (res2.session && res2.session.step === "start") clearMedia(chatId);
      }

      try {
        await chat.clearState();
      } catch (_) {}
      return; // no seguir con el branch de texto
    }

    // ===== 2) Mensajes de TEXTO =====
    const result = await handleText({ chatId, text: bodyRaw });
    const { replies, notifyAgent, session } = result;

    for (const t of replies) await client.sendMessage(chatId, t);

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
