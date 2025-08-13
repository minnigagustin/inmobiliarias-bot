// engine.js — Core del flujo (compartido entre WhatsApp y Web Chat)
// ✅ NLU híbrido (pre es-compromise → reglas → IA OpenAI)
// ✅ Manejo de fotos y conteo en el resumen
// ✅ Sí/No flexible y respuestas más naturales
// ✅ Deducción de categoría (“gas”, “plomería”, etc.) desde texto y descripción

const { classifyIntent } = require("./nlp");
const { preIntent } = require("./nlu_pre");

// ===== Estado =====
const sessions = new Map(); // chatId -> { step, data, history: [] }
function getSession(chatId) {
  if (!sessions.has(chatId))
    sessions.set(chatId, { step: "start", data: {}, history: [] });
  return sessions.get(chatId);
}
function reset(chatId) {
  const s = getSession(chatId); // ← usa el existente
  s.step = "start";
  s.data = {};
  s.history = [];
}
function pushHistory(s, text) {
  s.history = s.history || [];
  s.history.push(text);
  if (s.history.length > 6) s.history.shift();
}

const NLU_STEPS = new Set([
  "start",
  "main",
  "alquileres_menu",
  "prop_menu",
  "consultas_menu",
  "rep_categoria",
  "indices_menu",
]);

// ===== Helpers =====
function fmtCurrency(n) {
  if (typeof n !== "number" || isNaN(n)) return n;
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 2,
  }).format(n);
}

const REPORT_STEPS = new Set([
  "rep_categoria",
  "rep_direccion",
  "rep_desc",
  "rep_fotos_preg",
  "rep_fotos_subida",
  "rep_derivar",
]);

function num(v) {
  if (typeof v !== "string") return Number(v);
  const normalized = v.replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  return Number(normalized);
}
const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function mapIndice(k) {
  const m = {
    ICL: "ICL (BCRA)",
    CAC: "CAC (Construcción)",
    UVA: "UVA",
    UVI: "UVI",
    CER: "CER",
    CASA_PROPIA: "Coeficiente Casa Propia",
    IPC_INDEC_2M: "IPC (INDEC) – 2 meses",
    IPC_INDEC_1M: "IPC (INDEC) – 1 mes",
    IPC_CREEBBA_2M: "IPC (CREEBBA) – 2 meses",
    IPC_CREEBBA_1M: "IPC (CREEBBA) – 1 mes",
  };
  return k ? m[k] || null : null;
}

function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
function parseYesNo(text) {
  const t = stripAccents(String(text || "").toLowerCase()).trim();

  // Sí
  if (/^(si|s|sí)$/.test(t)) return "yes";
  if (/\b(dale|ok(ay)?|claro|por supuesto|de una|va|listo|perfecto)\b/.test(t))
    return "yes";
  if (
    /\b(quiero|necesito|me\s+contactan|contactame|llamame|llamenme|hablenme)\b/.test(
      t
    )
  )
    return "yes";

  // No
  if (/^(n|no|nop|noo|nah)$/.test(t)) return "no";
  if (
    /\b(no\s+gracias|gracias\s+pero\s+no|estoy\s+bien|por\s+ahora\s+no|no\s+hace\s+falta|prefiero\s+que\s+no|mas\s+tarde|despues)\b/.test(
      t
    )
  ) {
    return "no";
  }
  return null;
}

function resumenReporte(s) {
  return `✅ ¡Gracias! Registré:
• Categoría: ${s.data.categoria}
• Dirección: ${s.data.direccion}
• Descripción: ${s.data.descripcion}
${
  s.data.fotos && s.data.fotos.length
    ? `• Fotos: ${s.data.fotos.length}`
    : "• Fotos: no enviadas"
}`;
}

function resumenVenta(s) {
  const p = s.data.prop || {};
  return `📄 Datos para vender:
• Tipo: ${p.tipo || "-"}
• Dirección/Zona: ${p.direccion || "-"}
• Estado: ${p.estado || "-"}
• Comentarios: ${p.comentarios ? p.comentarios : "—"}`;
}

function pickMenuNumber(text, max = 9) {
  const m = String(text || "")
    .trim()
    .match(/^(?:op(?:ci[oó]n)?\s*)?([1-9])(?:\s*[\).\:]?)?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= max ? n : null;
}

// Reparación / disculpa
function isRepair(text) {
  const t = String(text || "").toLowerCase();
  return /no me entend(iste|es)|no era eso|eso no|te confund(iste|es)|me expres(e|é) mal|perd(o|ó)n.*(no|me|entend)/.test(
    t
  );
}

// 🔧 Deducción de categoría por tokens simples o descripción
function normalizeIssueCategory(v) {
  if (!v) return null;
  const t = String(v).toLowerCase();
  if (/\bgas\b|metrogas|ca(?:n|ñ)o de gas/.test(t)) return "Gas";
  if (/(electric|corto|enchufe|tablero|luz)/.test(t)) return "Electricidad";
  if (/(plomer|canilla|agua|gote|fuga|p[eé]rdida|ca(?:n|ñ)o|inund)/.test(t))
    return "Plomería";
  if (
    /(artefacto|termotan|calef[oó]n|calefactor|heladera|cocina|horno)/.test(t)
  )
    return "Artefacto roto";
  if (t === "plomería" || t === "plomeria") return "Plomería";
  if (t === "electricidad") return "Electricidad";
  if (t === "artefacto" || t === "artefacto roto") return "Artefacto roto";
  if (t === "otro" || t === "otros") return "Otro";
  return null;
}

// ===== Reglas rápidas =====
function cheapDetectIntent(text) {
  const t = text.toLowerCase();

  // Small talk
  if (
    /\b(gracias|muchas gracias|mil gracias|genial|b[áa]rbaro|perfecto|de nada)\b/.test(
      t
    )
  )
    return { intent: "thanks" };
  if (
    /\b(chau|adi[oó]s|hasta luego|nos vemos|buenas noches|buenas tardes|buen d[ií]a)\b/.test(
      t
    )
  )
    return { intent: "goodbye" };

  if (/(humano|operador|agente|asesor)/.test(t)) return { intent: "operator" };
  if (/(^|\s)(hola|buenas|menu|inicio|start)(\s|$)/.test(t))
    return { intent: "greeting" };
  if (/(inquilin)/.test(t)) return { intent: "tenant_info" };
  if (/(propietari|dueñ)/.test(t)) return { intent: "owner_info" };

  // Cobrar (prioridad sobre “alquilar”)
  if (
    /\b(cobro|cobrar|liquidaci[oó]n|rendici[oó]n)\b/.test(t) &&
    !/(quiero|busco|necesito|me interesa).{0,12}alquil/.test(t)
  ) {
    return { intent: "owner_info" };
  }

  // NUEVO: si el usuario pone solo “gas” / “plomería” / etc., consideralo reporte
  const catLite = normalizeIssueCategory(t);
  if (catLite && catLite !== "Otro") {
    return { intent: "report_issue", slots: { category: catLite } };
  }

  // Problemas con verbos/señales
  if (
    /(romp|gote|fuga|p[eé]rdida|corto|chispa|no anda|no funciona|descompuesto|perd[ií] la llave|canilla|inund)/.test(
      t
    )
  ) {
    let category = null;
    if (/(canilla|agua|gote)/.test(t)) category = "Plomería";
    else if (/\bgas\b/.test(t)) category = "Gas";
    else if (/(electric|corto|chispa|enchufe|luz)/.test(t))
      category = "Electricidad";
    else if (/(artefacto|termotan|calefon|heladera|cocina|horno)/.test(t))
      category = "Artefacto roto";
    return { intent: "report_issue", slots: { category } };
  }

  // Índices
  if (
    /(icl|cac|uva|uvi|cer|casa propia|ipc)/.test(t) ||
    /(actualizar|[ií]ndice)/.test(t)
  ) {
    let idx = null;
    if (/\bicl\b/.test(t)) idx = "ICL";
    else if (/\bcac\b/.test(t)) idx = "CAC";
    else if (/\buva\b/.test(t)) idx = "UVA";
    else if (/\buvi\b/.test(t)) idx = "UVI";
    else if (/\bcer\b/.test(t)) idx = "CER";
    else if (/casa propia/.test(t)) idx = "CASA_PROPIA";
    else if (/ipc.*indec.*2/.test(t)) idx = "IPC_INDEC_2M";
    else if (/ipc.*indec.*1/.test(t)) idx = "IPC_INDEC_1M";
    else if (/ipc.*creebba.*2/.test(t)) idx = "IPC_CREEBBA_2M";
    else if (/ipc.*creebba.*1/.test(t)) idx = "IPC_CREEBBA_1M";
    return { intent: "index_update", slots: { index: idx } };
  }

  // Propiedades (exigir verbo)
  if (
    /(alquil(ar|o|e|emos|en)|quiero\s+alquil|busco\s+alquiler|necesito\s+alquil)/.test(
      t
    )
  )
    return { intent: "properties_rent" };
  if (/(comprar|compra|quiero\s+comprar|busco\s+comprar)/.test(t))
    return { intent: "properties_buy" };
  if (/(temporari|por d[ií]a|por semana)/.test(t))
    return { intent: "properties_temp" };
  if (/(vender|venta|tasaci)/.test(t)) return { intent: "properties_sell" };

  return null;
}

// ===== Mini-FAQ =====
function quickAnswer(text) {
  const t = text.toLowerCase();
  if (
    /(horari|a qu[eé] hora|cu[aá]ndo ati|direcci|ubicaci|d[oó]nde est[aá]n)/.test(
      t
    )
  ) {
    return `📍 Dirección: [Dirección ficticia]
🕒 Horarios: Lunes a viernes de 9 a 13 y de 16 a 19 hs
📞 Teléfono alternativo: [Número ficticio]`;
  }
  if (
    /(c[oó]mo pago|forma[s]? de pago|medios de pago|pagar alquil|transferencia|efectivo)/.test(
      t
    )
  ) {
    return `💳 Formas de pago (demo):
• Transferencia bancaria
• Efectivo en oficina
• Plataformas electrónicas
Conservá siempre el comprobante.`;
  }
  if (
    /(tasaci|tasar|valor de mi propiedad|cu[aá]nto sale la tasaci[oó]n)/.test(t)
  ) {
    return `📏 Tasación (demo):
Coordinamos una visita sin costo para estimar el valor. ¿Querés que te contacte un asesor? Escribí *operador*.`;
  }
  if (/\b(qué es|que es)\b.*\b(icl|cac|uva|uvi|cer|casa propia)\b/.test(t)) {
    const idx = t.match(/\b(icl|cac|uva|uvi|cer|casa propia)\b/)[1];
    const def =
      {
        icl: "ICL: Índice de Contratos de Locación (BCRA) para actualización de alquileres.",
        cac: "CAC: Índice de la Cámara Argentina de la Construcción, usado en ajustes de obras/alquileres.",
        uva: "UVA: Unidad de Valor Adquisitivo (actualiza por inflación).",
        uvi: "UVI: Unidad de Vivienda (similar a UVA, referida a construcción).",
        cer: "CER: Coeficiente de Estabilización de Referencia (ajuste por inflación).",
        "casa propia":
          "Coeficiente Casa Propia: actualización de créditos/contratos del programa Casa Propia.",
      }[idx] || "Es un índice de actualización utilizado en contratos.";
    return `ℹ️ ${def}`;
  }
  if (
    /(renovar contrato|renovaci[oó]n|me atraso|pago tarde|inter[eé]s)/.test(t)
  ) {
    return `📌 Renovación y atrasos (demo):
• Renovación: gestionarla 60–90 días antes del vencimiento.
• Atrasos: pueden generar intereses y notificaciones. Avisá si sabés que vas a retrasarte.`;
  }
  return null;
}

// ===== Textos =====
function mainMenuText() {
  return [
    "👋 Hola, soy el asistente virtual de BR-Group Soluciones en Tecnología.",
    "Podés probar cómo funciona nuestro bot para inmobiliarias.",
    "",
    "¿En qué podemos ayudarte hoy?",
    "Opciones principales:",
    "1. Administración de alquileres",
    "2. Consulta de propiedades",
    "3. Consultas generales",
    "",
    "Tip: podés escribir con tus palabras (“se rompió la canilla”, “actualizar por ICL”…)",
    "o simplemente el número (ej.: 1, 2 o 3).",
  ].join("\n");
}
function alquileresMenuText() {
  return [
    "Opciones de administración de alquileres:",
    "1. Reportar un problema o rotura",
    "2. Actualizar alquiler por índice (ICL, CAC, UVA/UVI, CER, Casa Propia, IPC)",
    "3. Información para inquilinos",
    "4. Información para propietarios",
    "5. Hablar con un humano",
    "",
    "También podés describirlo con tus palabras (ej.: “fuga de gas”, “ICL”).",
  ].join("\n");
}
function indicesMenuText() {
  return [
    "Decime qué índice querés usar:",
    "ICL, CAC, UVA, UVI, CER, Casa Propia, IPC INDEC (1 o 2 meses), IPC CREEBBA (1 o 2 meses).",
    "Ejemplo: “ICL”, “IPC INDEC 2 meses”.",
  ].join("\n");
}
function inquilinosInfoText() {
  return `📌 Cómo pagar mi alquiler
Podés pagar por transferencia, efectivo en oficina o plataformas electrónicas. Guardá siempre el comprobante.

📌 Qué pasa si me atraso
Podrían generarse intereses, notificaciones de deuda y gestiones legales. Avisá antes si sabés que vas a retrasarte.

📌 Cómo renovar el contrato
Se gestiona entre 60 y 90 días antes del vencimiento. Revisá condiciones antes de firmar.

📌 Cómo presentar un reclamo
Contactá a la inmobiliaria, explicá el motivo, enviá fotos y pedí confirmación escrita.
`;
}
function propietariosInfoText() {
  return `📌 Cómo cobro los alquileres
Podés recibir el pago por transferencia, depósito o efectivo según lo acordado. Mantené tus datos bancarios actualizados.

📌 Qué impuestos administra BRGroup (demo)
Impuesto municipal, inmobiliario y servicios básicos (a modo de ejemplo).

📌 Cómo accedo a mis reportes
Por email, acceso web o copia impresa.
`;
}

// ===== Intent handler (NLU) =====
async function handleNLUIntent(nlu, s) {
  const replies = [];
  let notifyAgent = null;

  const body =
    nlu.followup_question && nlu.intent === "other"
      ? nlu.followup_question
      : null;

  switch (nlu.intent) {
    case "greeting":
      replies.push(mainMenuText());
      s.step = "main";
      break;
    case "thanks":
      replies.push(
        "✨ ¡De nada! ¿Querés algo más? Podés escribir *menu* para ver opciones."
      );
      break;
    case "goodbye":
      replies.push(
        "👋 ¡Hasta luego! Cuando quieras retomamos. Escribí *menu* para empezar de nuevo."
      );
      break;
    case "operator":
      replies.push("👤 Te derivo con un integrante del equipo. (Demo).");
      notifyAgent = { motivo: "Pedido de operador (NLU)" };
      break;

    case "tenant_info":
      replies.push(inquilinosInfoText());
      s.step = "alquileres_menu";
      replies.push(alquileresMenuText());
      break;

    case "owner_info":
      replies.push(propietariosInfoText());
      s.step = "alquileres_menu";
      replies.push(alquileresMenuText());
      break;

    case "report_issue": {
      // 1) lo que dijo la IA
      let cat = normalizeIssueCategory(nlu?.slots?.category);
      // 2) último mensaje del usuario (por si fue “gas” suelto)
      if (!cat || cat === "Otro") {
        const last = (s.history && s.history[s.history.length - 1]) || "";
        cat = normalizeIssueCategory(last) || cat;
      }
      s.data.categoria = cat;

      if (s.data.categoria && s.data.categoria !== "Otro") {
        s.step = "rep_direccion";
        replies.push("📍 Pasame la *dirección del inmueble*:");
      } else {
        s.step = "rep_categoria";
        replies.push(
          "¿Qué tipo de problema es? (Plomería, Gas, Electricidad, Artefacto roto u Otro)"
        );
      }
      break;
    }

    case "index_update":
      s.data.indice = mapIndice(nlu?.slots?.index);
      s.step = s.data.indice ? "ind_monto" : "indices_menu";
      replies.push(
        s.data.indice
          ? `Perfecto, *${s.data.indice}*. Ingresá el *alquiler actual*:`
          : indicesMenuText()
      );
      break;

    case "properties_rent":
      s.data.op = "alquilar";
      s.step = "prop_buscar_tipo";
      replies.push(
        "🧭 ¿Qué tipo de propiedad querés alquilar? (casa, depto, ph, etc.)"
      );
      break;
    case "properties_buy":
      s.data.op = "comprar";
      s.step = "prop_buscar_tipo";
      replies.push(
        "🧭 ¿Qué tipo de propiedad querés comprar? (casa, depto, ph, etc.)"
      );
      break;
    case "properties_temp":
      s.data.op = "temporario";
      s.step = "prop_buscar_tipo";
      replies.push(
        "🧭 ¿Qué tipo de propiedad buscás para temporario? (casa, depto, ph, etc.)"
      );
      break;
    case "properties_sell":
      s.data.op = "vender";
      s.step = "prop_vender_tipo";
      replies.push(
        "🧾 ¿Qué *tipo de propiedad* querés vender? (casa, depto, local, etc.)"
      );
      break;

    case "other":
    default:
      if (body) {
        replies.push(body);
        s.data.await = /cobrar|cobro/i.test(body)
          ? "owner_or_other"
          : "clarify_generic";
      } else {
        replies.push(
          "No me quedó claro. Por ejemplo: “se rompió la canilla”, “actualizar por ICL”, “alquilar depto en centro” o “operador”."
        );
      }
      break;
  }

  return { replies, notifyAgent };
}

// ===== Manejo de IMAGEN =====
async function handleImage({ chatId, file }) {
  const s = getSession(chatId);
  s.data.fotos = s.data.fotos || [];
  s.data.fotos.push(file);

  const replies = [];

  // si ya estaba en modo subir varias, mantener
  if (s.step === "rep_fotos_subida") {
    replies.push(
      "📸 ¡Foto recibida! Podés enviar otra. Cuando termines, escribí *listo*."
    );
    return { replies, session: s };
  }

  // si está en cualquier paso del flujo de daños, pasamos a "subida"
  if (
    [
      "rep_categoria",
      "rep_direccion",
      "rep_desc",
      "rep_fotos_preg",
      "rep_derivar",
    ].includes(s.step)
  ) {
    s.step = "rep_fotos_subida";
    replies.push(
      "📸 ¡Foto recibida! Podés enviar otra. Cuando termines, escribí *listo*."
    );
    return { replies, session: s };
  }

  // fuera del flujo de daños
  replies.push("📸 ¡Gracias por la imagen!");
  return { replies, session: s };
}

// ===== Main handleText =====
// ===== Main handleText (con soporte de menús numéricos 1–3 y 1–5) =====
async function handleText({ chatId, text }) {
  const s = getSession(chatId);
  pushHistory(s, text);

  const bodyRaw = (text || "").trim();
  const body = bodyRaw.toLowerCase();
  const replies = [];
  let notifyAgent = null;

  // Helper local: detectar "1", "2", "3", "opcion 2.", etc.
  function pickMenuNumberLocal(src, max = 9) {
    const m = String(src || "")
      .trim()
      .match(/^(?:op(?:ci[oó]n)?\s*)?([1-9])(?:\s*[\).\:]?)?$/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= max ? n : null;
  }

  // Atajos
  if (["menu", "inicio", "start", "/start"].includes(body)) {
    reset(chatId);
    replies.push(mainMenuText());
    return { replies, notifyAgent, session: getSession(chatId) };
  }
  if (["operador", "humano", "agente", "asesor"].includes(body)) {
    if (REPORT_STEPS.has(s.step)) {
      // diferir handoff y forzar el paso de fotos
      s.step = "rep_fotos_preg";
      return {
        replies: [
          "👤 Te paso con un agente enseguida. Antes, ¿tenés fotos para adjuntar? (sí/no)",
        ],
        notifyAgent: null,
        session: s,
      };
    }
    replies.push("👤 Te derivo con un integrante del equipo. (Demo).");
    notifyAgent = { motivo: "Pedido de operador" };
    return { replies, notifyAgent, session: s };
  }

  // Reparación
  if (isRepair(bodyRaw)) {
    s.data = {};
    s.step = "main";
    replies.push(
      "Uy, perdón — me confundí. Contame de nuevo con tus palabras qué necesitás y te ayudo. 🙂"
    );
    replies.push(mainMenuText());
    return { replies, notifyAgent, session: s };
  }

  // ===== Menú numérico: Principal (1–3) =====
  if (s.step === "start" || s.step === "main") {
    const nMain = pickMenuNumberLocal(bodyRaw, 3);
    if (nMain) {
      if (nMain === 1) {
        s.step = "alquileres_menu";
        replies.push(alquileresMenuText());
      } else if (nMain === 2) {
        s.step = "prop_menu";
        replies.push(
          "Contame si querés alquilar, comprar, temporario o vender; y el tipo (casa, depto, ph, etc.)."
        );
      } else if (nMain === 3) {
        s.step = "consultas_menu";
        replies.push(
          'Contame tu consulta o escribí "operador" para hablar con alguien del equipo.'
        );
      }
      return { replies, notifyAgent, session: s };
    }
  }

  // ===== Menú numérico: Alquileres (1–5) =====
  if (s.step === "alquileres_menu") {
    const nAlq = pickMenuNumberLocal(bodyRaw, 5);
    if (nAlq) {
      switch (nAlq) {
        case 1: // Reportar problema
          s.data.categoria = null;
          s.step = "rep_categoria";
          replies.push(
            "¿Qué tipo de problema es? (Plomería, Gas, Electricidad, Artefacto roto u Otro)"
          );
          break;
        case 2: // Índices
          s.step = "indices_menu";
          replies.push(indicesMenuText());
          break;
        case 3: // Info inquilinos
          replies.push(inquilinosInfoText());
          replies.push(alquileresMenuText());
          break;
        case 4: // Info propietarios
          replies.push(propietariosInfoText());
          replies.push(alquileresMenuText());
          break;
        case 5: // Humano
          replies.push("👤 Te derivo con un integrante del equipo. (Demo).");
          notifyAgent = { motivo: "Pedido de operador (número)" };
          break;
      }
      return { replies, notifyAgent, session: s };
    }
  }

  // Desambiguaciones pendientes
  if (s.data.await) {
    if (s.data.await === "owner_or_other") {
      if (/\balquiler\b/.test(body)) {
        s.data.await = null;
        replies.push(propietariosInfoText());
        s.step = "alquileres_menu";
        replies.push(alquileresMenuText());
        return { replies, notifyAgent, session: s };
      }
      if (/\botra cosa\b|otra|no|^n$/.test(body)) {
        s.data.await = null;
        replies.push(
          "Dale, contame un poco más de qué tema se trata y veo cómo ayudarte."
        );
        return { replies, notifyAgent, session: s };
      }
      replies.push(
        "¿Te referís a *cobrar el alquiler* o a otra cosa? Si es cobre de alquiler, decime *alquiler*."
      );
      return { replies, notifyAgent, session: s };
    }
    if (s.data.await === "clarify_generic") {
      if (body.split(/\s+/).length < 3) {
        replies.push(
          "Decime un poquito más de detalles así te ayudo mejor. 😊"
        );
        return { replies, notifyAgent, session: s };
      }
      s.data.await = null;
    }
  }

  // Mini-FAQ
  const quick = quickAnswer(bodyRaw);
  if (quick) {
    replies.push(quick);
    return { replies, notifyAgent, session: s };
  }

  // NLU (no en formularios)
  // en handleText, antes del bloque NLU:
  const expectingNumeric = [
    "ind_monto",
    "ind_inicial",
    "ind_final",
    "prop_dorm",
    "prop_banos",
    "rep_categoria", // 👈 AGREGAR ESTA LÍNEA
  ].includes(s.step);

  const canUseNLU = NLU_STEPS.has(s.step);

  if (!expectingNumeric && canUseNLU) {
    // pre-NLU
    const pre = preIntent(bodyRaw);
    if (pre && pre.intent) {
      const res = await handleNLUIntent(
        { intent: pre.intent, slots: pre.slots || {} },
        s
      );
      replies.push(...res.replies);
      notifyAgent = res.notifyAgent || notifyAgent;
      return { replies, notifyAgent, session: s };
    }
    if (
      pre &&
      pre.hint &&
      typeof pre.hint.budget === "number" &&
      s.step === "prop_presupuesto"
    ) {
      const p = Number(pre.hint.budget);
      if (p > 0) {
        s.data.prop = s.data.prop || { op: s.data.op || "alquilar" };
        s.data.prop.presupuesto = p;
        s.step = "prop_zona";
        replies.push(`💰 Tomé tu presupuesto: ${fmtCurrency(p)}`);
        replies.push("📍 Zona / barrio preferido:");
        return { replies, notifyAgent, session: s };
      }
    }

    // reglas
    const cheap = cheapDetectIntent(bodyRaw);
    if (cheap) {
      const res = await handleNLUIntent(
        { intent: cheap.intent, slots: cheap.slots || {} },
        s
      );
      replies.push(...res.replies);
      notifyAgent = res.notifyAgent || notifyAgent;
      return { replies, notifyAgent, session: s };
    }

    // IA
    const nlu = await classifyIntent({
      text: bodyRaw,
      history: s.history,
      step: s.step,
    });
    if (nlu && nlu.intent) {
      const res = await handleNLUIntent(nlu, s);
      replies.push(...res.replies);
      notifyAgent = res.notifyAgent || notifyAgent;
      if (
        nlu.intent === "other" &&
        nlu.followup_question &&
        /cobrar|cobro/i.test(nlu.followup_question)
      )
        s.data.await = "owner_or_other";
      return { replies, notifyAgent, session: s };
    }
  }

  // FSM clásica
  switch (s.step) {
    case "start":
      replies.push(mainMenuText());
      s.step = "main";
      break;
    case "main":
      replies.push(mainMenuText());
      s.step = "main";
      break;

    // Reporte problema
    case "rep_categoria": {
      const map = {
        1: "Plomería",
        2: "Gas",
        3: "Electricidad",
        4: "Artefacto roto",
        5: "Otro",
      };
      s.data.categoria = map[body] || capitalize(bodyRaw); // funciona con "1" ó "plomería"
      s.step = "rep_direccion";
      replies.push("📍 Pasame la *dirección del inmueble*:");
      break;
    }
    case "rep_direccion": {
      s.data.direccion = bodyRaw;
      s.step = "rep_desc";
      replies.push(
        "📝 Contame una *descripción* (qué pasó, desde cuándo). Podés adjuntar foto si querés."
      );
      break;
    }
    case "rep_desc": {
      const deduced = normalizeIssueCategory(bodyRaw);
      if (!s.data.categoria || s.data.categoria === "Otro") {
        if (deduced) s.data.categoria = deduced;
      }
      s.data.descripcion = bodyRaw;
      s.step = "rep_fotos_preg";
      replies.push("📷 ¿Tenés fotos para adjuntar? (sí/no)");
      break;
    }
    case "rep_fotos_preg": {
      const yn = parseYesNo(bodyRaw);
      if (yn === "yes") {
        s.step = "rep_fotos_subida";
        replies.push(
          "Perfecto. Adjuntá la(s) foto(s). Cuando termines, escribí *listo*."
        );
      } else if (yn === "no") {
        s.step = "rep_derivar";
        replies.push(
          `${resumenReporte(
            s
          )}\n\n¿Querés que te atienda alguien del equipo? (sí/no)`
        );
      } else {
        replies.push('Respondé "sí" o "no", por favor.');
      }
      break;
    }
    case "rep_fotos_subida": {
      if (/^(listo|lista|ya|ok|de una|dale)$/i.test(bodyRaw.trim())) {
        s.step = "rep_derivar";
        replies.push(
          `${resumenReporte(
            s
          )}\n\n¿Querés que te atienda alguien del equipo? (sí/no)`
        );
      } else {
        replies.push(
          "Podés adjuntar fotos ahora. Cuando termines, escribí *listo*."
        );
      }
      break;
    }
    case "rep_derivar": {
      const yn = parseYesNo(bodyRaw);
      if (yn === "yes") {
        notifyAgent = {
          categoria: s.data.categoria,
          direccion: s.data.direccion,
          descripcion: s.data.descripcion,
          fotos: (s.data.fotos || []).map((f) => f.url),
        };
        replies.push("👤 Te derivo con un integrante del equipo. ¡Gracias!");
        reset(chatId);
      } else if (yn === "no") {
        replies.push(
          "👍 Entendido. Lo dejamos registrado. Si necesitás algo más, escribí *menu* para volver al inicio."
        );
        reset(chatId);
      } else {
        replies.push('Respondé "sí" o "no", por favor.');
      }
      break;
    }

    // Índices
    case "indices_menu": {
      replies.push(indicesMenuText());
      break;
    }
    case "ind_monto": {
      const monto = num(bodyRaw);
      if (!monto || monto <= 0)
        replies.push("Monto inválido. Probá de nuevo (solo números).");
      else {
        s.data.monto = monto;
        s.step = "ind_inicial";
        replies.push("Ingresá el *valor del índice inicial* (ej: 21,54):");
      }
      break;
    }
    case "ind_inicial": {
      const v = num(bodyRaw);
      if (!v || v <= 0) replies.push("Valor inválido. Probá de nuevo.");
      else {
        s.data.ind_val_inicial = v;
        s.step = "ind_final";
        replies.push("Ingresá el *valor del índice final* (ej: 24,19):");
      }
      break;
    }
    case "ind_final": {
      const v = num(bodyRaw);
      if (!v || v <= 0) replies.push("Valor inválido. Probá de nuevo.");
      else {
        s.data.ind_val_final = v;
        const factor = s.data.ind_val_final / s.data.ind_val_inicial;
        const variacionPct = (factor - 1) * 100;
        const nuevo = s.data.monto * factor;
        s.step = "ind_derivar";
        s.data.calculo = `Factor: ${factor.toFixed(6)} (${variacionPct.toFixed(
          2
        )} %), Nuevo: ${fmtCurrency(nuevo)}`;
        replies.push(
          `🧮 Resultado para *${s.data.indice || "Índice seleccionado"}*:
• Alquiler actual: ${fmtCurrency(s.data.monto)}
• Factor: ${factor.toFixed(6)} (${variacionPct.toFixed(2)} %)
• Nuevo alquiler: ${fmtCurrency(nuevo)}

¿Querés que te atienda alguien del equipo? (sí/no)`
        );
      }
      break;
    }
    case "ind_derivar": {
      const yn = parseYesNo(bodyRaw);
      if (yn === "yes") {
        notifyAgent = { indice: s.data.indice, calculo: s.data.calculo };
        replies.push("👤 Te derivo con un integrante del equipo. ¡Gracias!");
        reset(chatId);
      } else if (yn === "no") {
        replies.push(
          "👍 Perfecto. Si necesitás algo más, escribí *menu* para volver al inicio."
        );
        reset(chatId);
      } else {
        replies.push('Respondé "sí" o "no", por favor.');
      }
      break;
    }

    // Propiedades
    case "prop_menu": {
      replies.push(
        "Contame si querés alquilar, comprar, temporario o vender; y el tipo (“casa”, “depto”, “ph”…)."
      );
      break;
    }
    case "prop_buscar_tipo": {
      s.data.prop = { tipo: bodyRaw, op: s.data.op || "alquilar" };
      s.step = "prop_presupuesto";
      replies.push("💰 Indicá *presupuesto aproximado* (ej: 250000):");
      break;
    }
    case "prop_presupuesto": {
      const p = num(bodyRaw);
      if (!p || p <= 0) replies.push("Valor inválido. Probá de nuevo.");
      else {
        s.data.prop.presupuesto = p;
        s.step = "prop_zona";
        replies.push("📍 Zona / barrio preferido:");
      }
      break;
    }
    case "prop_zona": {
      s.data.prop.zona = bodyRaw;
      s.step = "prop_dorm";
      replies.push("🛏️ Dormitorios (número):");
      break;
    }
    case "prop_dorm": {
      const d = parseInt(bodyRaw, 10);
      if (isNaN(d) || d < 0) replies.push("Ingresá un número (0,1,2,3...).");
      else {
        s.data.prop.dorm = d;
        s.step = "prop_banos";
        replies.push("🛁 Baños (número):");
      }
      break;
    }
    case "prop_banos": {
      const b = parseInt(bodyRaw, 10);
      if (isNaN(b) || b < 0) replies.push("Ingresá un número (0,1,2...).");
      else {
        s.data.prop.banos = b;
        s.step = "prop_cochera";
        replies.push("🚗 ¿Cochera? (sí/no):");
      }
      break;
    }
    case "prop_cochera": {
      s.data.prop.cochera = ["si", "sí", "yes", "ok"].includes(body)
        ? "Sí"
        : "No";
      s.step = "prop_comodidades";
      replies.push(
        "🧩 Comodidades (ej: balcón, patio, parrilla). Podés listar varias:"
      );
      break;
    }
    // --------- Venta de propiedad ---------
    case "prop_vender_tipo": {
      s.data.prop = { op: "vender", tipo: bodyRaw };
      s.step = "prop_vender_dir";
      replies.push("📍 Pasame *dirección aproximada o zona* del inmueble:");
      break;
    }
    case "prop_vender_dir": {
      s.data.prop.direccion = bodyRaw;
      s.step = "prop_vender_estado";
      replies.push(
        "🏷️ ¿*Estado general*? (ej.: a refaccionar, bueno, muy bueno/reciclado, a estrenar)"
      );
      break;
    }
    case "prop_vender_estado": {
      s.data.prop.estado = capitalize(bodyRaw);
      s.step = "prop_vender_comentarios";
      replies.push(
        "🧾 *Comentarios adicionales* (m², antigüedad, amenities). Si no tenés, escribí *listo*."
      );
      break;
    }
    case "prop_vender_comentarios": {
      if (!/^listo|lista$/i.test(bodyRaw.trim())) {
        s.data.prop.comentarios = bodyRaw;
      }
      s.step = "prop_vender_derivar";
      replies.push(
        `${resumenVenta(
          s
        )}\n\n¿Querés que un asesor te contacte para coordinar *tasación*? (sí/no)`
      );
      break;
    }
    case "prop_vender_derivar": {
      const yn = parseYesNo(bodyRaw);
      if (yn === "yes") {
        notifyAgent = { motivo: "Vender propiedad", propform: s.data.prop };
        replies.push("👤 Te derivo con un integrante del equipo. ¡Gracias!");
        reset(chatId);
      } else if (yn === "no") {
        replies.push(
          "👍 Perfecto. Si necesitás algo más, escribí *menu* para volver al inicio."
        );
        reset(chatId);
      } else {
        replies.push('Respondé "sí" o "no", por favor.');
      }
      break;
    }
    case "prop_comodidades": {
      s.data.prop.comodidades = bodyRaw;
      const demo = [
        {
          titulo: "Depto 2 amb. c/balcón – Centro",
          precio: fmtCurrency(s.data.prop.presupuesto),
        },
        {
          titulo: "PH 3 amb. c/patio – Barrio Norte",
          precio: fmtCurrency(s.data.prop.presupuesto * 1.1),
        },
        {
          titulo: "Casa 3 dorm. c/cochera – Oeste",
          precio: fmtCurrency(s.data.prop.presupuesto * 1.3),
        },
      ];
      replies.push(
        `🔎 Búsqueda *${s.data.prop.op}* – *${s.data.prop.tipo}*
• Presupuesto: ${fmtCurrency(s.data.prop.presupuesto)}
• Zona: ${s.data.prop.zona}
• Dorm: ${s.data.prop.dorm} | Baños: ${s.data.prop.banos} | Cochera: ${
          s.data.prop.cochera
        }
• Comodidades: ${s.data.prop.comodidades}

📄 Resultados (demo):
1) ${demo[0].titulo} – ${demo[0].precio}
2) ${demo[1].titulo} – ${demo[1].precio}
3) ${demo[2].titulo} – ${demo[2].precio}

¿Querés que un asesor te contacte? (sí/no)`
      );
      s.step = "prop_buscar_derivar";
      break;
    }
    case "prop_buscar_derivar": {
      const yn = parseYesNo(bodyRaw);
      if (yn === "yes") {
        notifyAgent = {
          propform: s.data.prop,
          motivo: "Consulta de propiedades",
        };
        replies.push("👤 Te derivo con un integrante del equipo (simulado).");
        reset(chatId);
      } else if (yn === "no") {
        replies.push(
          "👍 Queda guardado. Si querés volver al inicio, escribí *menu*."
        );
        reset(chatId);
      } else {
        replies.push('Respondé "sí" o "no", por favor.');
      }
      break;
    }

    // Consultas generales
    case "consultas_menu": {
      if (/ubicaci|direcci|d[oó]nde|horari/.test(body)) {
        replies.push(
          `📍 Dirección: [Dirección ficticia]
🕒 Horarios: Lunes a viernes de 9 a 13 y de 16 a 19 hs
📞 Teléfono alternativo: [Número ficticio]`
        );
      } else {
        replies.push(
          'Contame tu consulta o escribí "operador" para hablar con alguien del equipo.'
        );
      }
      break;
    }

    default:
      reset(chatId);
      replies.push(mainMenuText());
  }

  return { replies, notifyAgent, session: s };
}

module.exports = { handleText, handleImage, reset, getSession };
