// engine.js — Core del flujo (compartido entre WhatsApp y Web Chat)
// ✅ NLU híbrido (pre es-compromise → reglas → IA OpenAI)
// ✅ Manejo de fotos y conteo en el resumen
// ✅ Sí/No flexible y respuestas más naturales
// ✅ Deducción de categoría (“gas”, “plomería”, etc.) desde texto y descripción

const { classifyIntent, answerFAQ } = require("./nlp");
const { preIntent } = require("./nlu_pre");
const { searchProperties } = require("./wpProperties");

const COMPANY_NAME = process.env.COMPANY_NAME || "Tu inmobiliaria";
const BOT_NAME = process.env.BOT_NAME || "asistente virtual";

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

function isSkip(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase();
  return (
    t === "." ||
    t === "-" ||
    t === "—" ||
    t === "ninguno" ||
    t === "ninguna" ||
    t === "no" ||
    t === "nop" ||
    t === "na" ||
    t === "n/a" ||
    t === "no tengo" ||
    t === "cualquiera" ||
    t === "indistinto" ||
    t === "da igual"
  );
}
function asOptionalText(text) {
  return isSkip(text) ? null : String(text || "").trim();
}

function fmtCurrency(n) {
  if (typeof n !== "number" || isNaN(n)) return n;
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 2,
  }).format(n);
}

// --- NUEVO: formato según moneda ---
function fmtAmount(n, currency = "ARS") {
  if (typeof n !== "number" || isNaN(n)) return n;
  const cur = currency === "USD" ? "USD" : "ARS";
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: cur,
    maximumFractionDigits: 2,
  }).format(n);
}

// --- NUEVO: menú y parser de moneda ---
function currencyMenuText(label = "monto") {
  return [
    `💱 ¿Moneda del ${label}?`,
    "1) Pesos (ARS)",
    "2) Dólares (USD)",
    "Tip: respondé 1/2, A/B, “pesos/ARS” o “dólares/USD”.",
  ].join("\n");
}
function parseCurrency(text) {
  const t = String(text || "")
    .toLowerCase()
    .trim();
  if (/^(1|a)$/.test(t) || /\b(ars|peso|pesos|\$)\b/.test(t)) return "ARS";
  if (
    /^(2|b)$/.test(t) ||
    /\b(usd|u\$d|u\$s|us\$|dolar|dólar|dolares|dólares|u\.?s\.?d\.?)\b/.test(t)
  )
    return "USD";
  return null;
}

const REPORT_STEPS = new Set([
  "rep_categoria",
  "rep_direccion",
  "rep_desc",
  "rep_fotos_preg",
  "rep_fotos_subida",
  "rep_derivar",
]);

// ==== AI mode (Consultas Generales) ====
const AI_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutos

function isAIMode(s) {
  return s.step === "consultas_ia" && s.data?.ai?.active;
}
function enterAIMode(s) {
  s.data.ai = { active: true, expiresAt: Date.now() + AI_TIMEOUT_MS };
  s.step = "consultas_ia";
}
function touchAIMode(s) {
  if (isAIMode(s)) s.data.ai.expiresAt = Date.now() + AI_TIMEOUT_MS;
}
function expireAIModeIfNeeded(s) {
  if (!isAIMode(s)) return false;
  if (Date.now() > (s.data.ai.expiresAt || 0)) {
    s.data.ai.active = false;
    s.step = "consultas_menu";
    return true;
  }
  return false;
}
function exitAIMode(s) {
  if (s.data?.ai) s.data.ai.active = false;
  s.step = "consultas_menu";
}

// Export utilitarias para otros procesos
function engineExitAI(chatId) {
  const s = getSession(chatId);
  exitAIMode(s);
  return s;
}
function engineTouchAI(chatId) {
  const s = getSession(chatId);
  if (isAIMode(s)) {
    touchAIMode(s);
    return s.data.ai.expiresAt;
  }
  return null;
}

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

const INDEX_KEYS = [
  "ICL",
  "CAC",
  "UVA",
  "UVI",
  "CER",
  "CASA_PROPIA",
  "IPC_INDEC_1M",
  "IPC_INDEC_2M",
  "IPC_CREEBBA_1M",
  "IPC_CREEBBA_2M",
];
function propiedadesOperacionMenuText() {
  return [
    "🏷️ *Consulta de propiedades*",
    "Elegí una opción (número o letra):",
    "1) Alquilar",
    "2) Comprar",
    "3) Temporario",
    "4) Vender",
    "Tip: podés escribir 1/2/3/4 o A/B/C/D.",
  ].join("\n");
}
function propiedadesTipoMenuText(op) {
  const verb =
    op === "comprar"
      ? "comprar"
      : op === "temporario"
      ? "alquilar (temporario)"
      : "alquilar";
  return [
    `Elegiste *${op}*. ¿Qué tipo de propiedad querés ${verb}?`,
    "Elegí (número o letra):",
    "1) Casa",
    "2) Depto",
    "3) PH",
    "4) Otro",
    "Tip: podés escribir 1/2/3/4 o A/B/C/D.",
    "También podés escribir el tipo (ej.: casa, depto, ph).",
  ].join("\n");
}

function normalizePropType(raw) {
  const t = String(raw || "").toLowerCase();
  if (/^1$|^a$|^casa\b/.test(t)) return "casa";
  if (/^2$|^b$|^depto\b|departament/.test(t)) return "depto";
  if (/^3$|^c$|^ph\b/.test(t)) return "ph";
  if (/^4$|^d$|^otro\b/.test(t)) return "otro";
  // si no coincide, devolvemos el texto como “otro” explícito
  if (t.trim()) return t.trim();
  return null;
}

// 1–9 (ya existe pickMenuNumber); extendemos a 1–10 con esta variante
function pickMenuNumber10(text) {
  const m = String(text || "")
    .trim()
    .match(/^(?:op(?:ci[oó]n)?\s*)?([1-9]|10)(?:\s*[\).\:]?)?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 10 ? n : null;
}

// A–Z (acepta "a", "B.", "opcion c", "D)")
function pickLetterChoice(text, max = 26) {
  const m = String(text || "")
    .trim()
    .match(/^(?:op(?:ci[oó]n)?\s*)?([a-z])(?:\s*[\).\:]?)?$/i);
  if (!m) return null;
  const n = m[1].toLowerCase().charCodeAt(0) - "a".charCodeAt(0) + 1;
  return n >= 1 && n <= max ? n : null;
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

  // Evitar falsos positivos cuando preguntan por sellado/impuesto de sellos
  const isStampQuestion = /\b(sellad\w*|impuesto(s)?\s+de\s+sellos?)\b/.test(t);

  // Pedido de humano
  if (/(humano|operador|agente|asesor)/.test(t)) return { intent: "operator" };

  // Saludo / menú
  if (/(^|\s)(hola|buenas|menu|inicio|start)(\s|$)/.test(t))
    return { intent: "greeting" };

  // ⚠️ Antes se activaba por cualquier "inquilino"/"propietario".
  // Ahora solo si se IDENTIFICA o pide info explícitamente, y NO si habla de sellado.
  if (
    !isStampQuestion &&
    (/\b(soy\s+)?inquilin[oa]s?\b/.test(t) ||
      /\binfo\s+para\s+inquilin[oa]s?\b/.test(t))
  )
    return { intent: "tenant_info" };
  if (
    !isStampQuestion &&
    (/\b(soy\s+)?propietari[oa]s?\b/.test(t) ||
      /\binfo\s+para\s+propietari[oa]s?\b/.test(t))
  )
    return { intent: "owner_info" };

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
    /(romp|gote|fuga|p[eé]rdida|corto|chispa|no anda|no funciona|descompuesto|perd[ií]\s+la\s+llave|canilla|inund)/.test(
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
    `👋 Hola, soy ${BOT_NAME} de ${COMPANY_NAME}.`,
    "¿En qué podemos ayudarte hoy?",
    "",
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
    "5. Hablar con un operador",
    "",
    "También podés describirlo con tus palabras (ej.: “fuga de gas”, “ICL”).",
  ].join("\n");
}
function indicesMenuText() {
  return [
    "Decime qué índice querés usar (podés escribir el *nombre*, o *1–10* o *A–J*):",
    "1) ICL",
    "2) CAC",
    "3) UVA",
    "4) UVI",
    "5) CER",
    "6) Casa Propia",
    "7) IPC INDEC 1 mes",
    "8) IPC INDEC 2 meses",
    "9) IPC CREEBBA 1 mes",
    "10) IPC CREEBBA 2 meses",
    "Ejemplo: “ICL”, “8”, “B”.",
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

function fmtPropCard(p) {
  const imgLine = p.image ? `📷 Foto: ${p.image}\n` : "";
  const desc = p.excerpt ? `📝 ${p.excerpt}\n` : "";
  return (
    `🏠 *${p.title}*\n` +
    `💰 *${fmtAmount(p.price, p.currency)}*\n` +
    imgLine +
    desc +
    `🔗 Ver publicación: ${p.link}`
  );
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
          ? `Perfecto, *${s.data.indice}*. Ingresá el *alquiler actual* (solo número). Después te pregunto la moneda.`
          : indicesMenuText()
      );
      break;
    case "properties_rent":
      s.data.op = "alquilar";
      s.step = "prop_tipo_menu";
      replies.push(propiedadesTipoMenuText("alquilar"));
      break;

    case "properties_buy":
      s.data.op = "comprar";
      s.step = "prop_tipo_menu";
      replies.push(propiedadesTipoMenuText("comprar"));
      break;

    case "properties_temp":
      s.data.op = "temporario";
      s.step = "prop_tipo_menu";
      replies.push(propiedadesTipoMenuText("temporario"));
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
  if (["menu", "inicio", "start", "/start", "salir", "exit"].includes(body)) {
    reset(chatId); // sale de cualquier modo (incluida IA)
    replies.push(mainMenuText());
    return {
      replies,
      notifyAgent,
      session: getSession(chatId),
      aiSignal: { mode: "off" },
    };
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

  // ===== MODO IA ACTIVO (consultas_ia) =====
  if (isAIMode(s)) {
    const expired = expireAIModeIfNeeded(s);
    if (!expired) {
      const ai = await answerFAQ({
        text: bodyRaw,
        history: s.history,
        step: s.step,
      });
      replies.push(ai);
      replies.push("Tip: escribí *menu* o *salir* para volver al inicio.");
      touchAIMode(s);
      return {
        replies,
        notifyAgent,
        session: s,
        aiSignal: { mode: "extend", until: s.data.ai.expiresAt },
      };
    }
    // si expiró, dejamos que el mensaje actual siga el flujo normal (ya fuera de IA)
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
  // ===== Menú principal: acepta 1–3 o A–C =====
  if (s.step === "start" || s.step === "main") {
    const nMain = pickMenuNumberLocal(bodyRaw, 3);
    const lMain = pickLetterChoice(bodyRaw, 3);
    const choice = nMain || lMain;

    if (choice) {
      switch (choice) {
        case 1:
          s.step = "alquileres_menu";
          replies.push(alquileresMenuText());
          break;
        case 2:
          s.step = "prop_menu";
          replies.push(propiedadesOperacionMenuText());
          break;
        case 3:
          s.step = "consultas_menu";
          replies.push(
            'Contame tu consulta o escribí "operador" para hablar con alguien del equipo.'
          );
          break;
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

  // ===== Menú: Índices (1–10 o A–J) =====
  if (s.step === "indices_menu") {
    const byNum = pickMenuNumber10(bodyRaw);
    const byLet = pickLetterChoice(bodyRaw, 10);
    const pos = byNum || byLet;

    if (pos) {
      const key = INDEX_KEYS[pos - 1];
      const label = mapIndice(key) || key;
      s.data.indice = label;
      s.step = "ind_monto";
      replies.push(`Perfecto, *${label}*. Ingresá el *alquiler actual*:`);

      return { replies, notifyAgent, session: s };
    }
    // si no eligió por código, seguimos el flujo normal (NLU o texto libre)
  }

  // ===== Menú: Propiedades (1–4 o A–D) — capturar ANTES de NLU =====
  if (s.step === "prop_menu") {
    const byNum = (function pickMenuNumberLocal(src, max = 9) {
      const m = String(src || "")
        .trim()
        .match(/^(?:op(?:ci[oó]n)?\s*)?([1-9])(?:\s*[\).\:]?)?$/i);
      if (!m) return null;
      const n = parseInt(m[1], 10);
      return n >= 1 && n <= max ? n : null;
    })(bodyRaw, 4);
    const byLet = pickLetterChoice(bodyRaw, 4);

    let op = null;
    if (byNum || byLet) {
      const pos = byNum || byLet;
      op = ["alquilar", "comprar", "temporario", "vender"][pos - 1];
    } else if (/^alquil/.test(body)) op = "alquilar";
    else if (/^compr/.test(body)) op = "comprar";
    else if (/temporari/.test(body)) op = "temporario";
    else if (/^vender|venta|tasaci/.test(body)) op = "vender";

    if (!op) {
      replies.push(propiedadesOperacionMenuText());
      return { replies, notifyAgent, session: s };
    }

    s.data.op = op;
    if (op === "vender") {
      s.step = "prop_vender_tipo";
      replies.push(
        "🧾 ¿Qué *tipo de propiedad* querés vender? (casa, depto, local, etc.)"
      );
    } else {
      s.step = "prop_tipo_menu";
      replies.push(propiedadesTipoMenuText(op));
    }
    return { replies, notifyAgent, session: s };
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

  // ===== CONSULTAS GENERALES → IA si no hay respuesta rápida =====
  if (s.step === "consultas_menu") {
    const quickCg = quickAnswer(bodyRaw);
    if (quickCg) {
      replies.push(quickCg);
      return { replies, notifyAgent, session: s };
    }
    enterAIMode(s);
    const ai = await answerFAQ({
      text: bodyRaw,
      history: s.history,
      step: s.step,
    });
    replies.push(ai);
    replies.push(
      "Seguimos en *modo consulta*. Escribí *menu* o *salir* para volver."
    );
    return {
      replies,
      notifyAgent,
      session: s,
      aiSignal: { mode: "on", until: s.data.ai.expiresAt },
    };
  }

  // Mini-FAQ rápida (reglas)
  const quick = quickAnswer(bodyRaw);
  if (quick) {
    replies.push(quick);
    return { replies, notifyAgent, session: s };
  }

  // Formularios donde NO queremos NLU
  const expectingNumeric = [
    "ind_monto",
    "ind_inicial",
    "ind_final",
    "prop_dorm",
    "prop_banos",
    "rep_categoria",
  ].includes(s.step);

  const canUseNLU = NLU_STEPS.has(s.step);

  // ===== Menú: Propiedades (1–4 o A–D) — capturar ANTES de NLU =====
  if (s.step === "prop_menu") {
    const byNum = (function pickMenuNumberLocal(src, max = 9) {
      const m = String(src || "")
        .trim()
        .match(/^(?:op(?:ci[oó]n)?\s*)?([1-9])(?:\s*[\).\:]?)?$/i);
      if (!m) return null;
      const n = parseInt(m[1], 10);
      return n >= 1 && n <= max ? n : null;
    })(bodyRaw, 4);
    const byLet = pickLetterChoice(bodyRaw, 4);

    let op = null;
    if (byNum || byLet) {
      const pos = byNum || byLet;
      op = ["alquilar", "comprar", "temporario", "vender"][pos - 1];
    } else if (/^alquil/.test(body)) op = "alquilar";
    else if (/^compr/.test(body)) op = "comprar";
    else if (/temporari/.test(body)) op = "temporario";
    else if (/^vender|venta|tasaci/.test(body)) op = "vender";

    if (!op) {
      replies.push(propiedadesOperacionMenuText());
      return { replies, notifyAgent, session: s };
    }

    s.data.op = op;
    if (op === "vender") {
      s.step = "prop_vender_tipo";
      replies.push(
        "🧾 ¿Qué *tipo de propiedad* querés vender? (casa, depto, local, etc.)"
      );
    } else {
      s.step = "prop_tipo_menu";
      replies.push(propiedadesTipoMenuText(op));
    }
    return { replies, notifyAgent, session: s };
  }

  if (!expectingNumeric && canUseNLU) {
    // --------- Capa pre-NLU ---------
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

    // --------- Reglas rápidas ---------
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

    // --------- IA (NLU + fallback QA) ---------
    const nlu = await classifyIntent({
      text: bodyRaw,
      history: s.history,
      step: s.step,
    });

    if (nlu && nlu.intent) {
      // 🔺 Escalada a QA generativa si 'other' se repite o si parece pregunta
      const isQuestion =
        /[?]|(^|\s)(c[oó]mo|como|qu[eé]|que|qui[eé]n|quien|cu[aá]ndo|cuando|d[oó]nde|donde|por ?qu[eé]|por que|cu[aá]l|cual|cu[aá]nt[oa]s?|cuanto)/i.test(
          bodyRaw
        );

      if (nlu.intent === "other") {
        s.data.otherStreak = (s.data.otherStreak || 0) + 1;

        // 1ra vez: si trae followup, preguntamos y esperamos
        if (s.data.otherStreak === 1 && nlu.followup_question) {
          replies.push(nlu.followup_question);
          s.data.await = "clarify_generic";
          return { replies, notifyAgent, session: s };
        }

        // Condición de escalada: 2+ 'other' seguidos o pregunta clara + cooldown
        const now = Date.now();
        const cooldownOk = !s.data.lastAI || now - s.data.lastAI > 15000;
        if ((s.data.otherStreak >= 2 || isQuestion) && cooldownOk) {
          const ai = await answerFAQ({
            text: bodyRaw,
            history: s.history,
            step: s.step,
          });
          replies.push(ai);
          replies.push("¿Querés que un asesor te contacte? (sí/no)");
          s.data.otherStreak = 0;
          s.data.lastAI = now;
          s.step = "consultas_menu"; // o mantené el step si preferís
          return { replies, notifyAgent, session: s };
        }
      } else {
        // cualquier intent distinto resetea el streak
        s.data.otherStreak = 0;
      }

      // Flujo normal cuando no escalamos
      const res = await handleNLUIntent(nlu, s);
      replies.push(...res.replies);
      notifyAgent = res.notifyAgent || notifyAgent;

      if (
        nlu.intent === "other" &&
        nlu.followup_question &&
        /cobrar|cobro/i.test(nlu.followup_question)
      ) {
        s.data.await = "owner_or_other";
      }

      return { replies, notifyAgent, session: s };
    }
  }

  // ===== FSM clásica =====
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
      s.data.categoria = map[body] || capitalize(bodyRaw);
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
      if (!monto || monto <= 0) {
        replies.push("Monto inválido. Probá de nuevo (solo números, sin $).");
      } else {
        s.data.monto = monto;
        s.step = "ind_moneda"; // ← NUEVO paso
        replies.push(currencyMenuText("alquiler actual"));
      }
      break;
    }
    case "ind_moneda": {
      const cur = parseCurrency(bodyRaw);
      if (!cur) {
        replies.push(currencyMenuText("alquiler actual"));
      } else {
        s.data.moneda = cur; // "ARS" | "USD"
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
        const factor = v / s.data.ind_val_inicial;
        const variacionPct = (factor - 1) * 100;
        const nuevo = s.data.monto * factor;
        const cur = s.data.moneda || "ARS";

        s.step = "ind_derivar";
        s.data.ind_val_final = v;
        s.data.calculo =
          `Factor: ${factor.toFixed(6)} (${variacionPct.toFixed(2)} %), ` +
          `Nuevo: ${fmtAmount(nuevo, cur)}`;

        replies.push(
          `🧮 Resultado para *${s.data.indice || "Índice seleccionado"}*:
• Alquiler actual: ${fmtAmount(s.data.monto, cur)}
• Factor: ${factor.toFixed(6)} (${variacionPct.toFixed(2)} %)
• Nuevo alquiler: ${fmtAmount(nuevo, cur)}

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
      // aceptar número/letra o texto (alquilar/comprar/temporario/vender)
      const byNum = pickMenuNumberLocal(bodyRaw, 4);
      const byLet = pickLetterChoice(bodyRaw, 4);
      const t = body.toLowerCase();

      let op = null;
      if (byNum || byLet) {
        const pos = byNum || byLet;
        op = ["alquilar", "comprar", "temporario", "vender"][pos - 1];
      } else if (/^alquil/.test(t)) op = "alquilar";
      else if (/^compr/.test(t)) op = "comprar";
      else if (/temporari/.test(t)) op = "temporario";
      else if (/^vender|venta|tasaci/.test(t)) op = "vender";

      if (!op) {
        replies.push(propiedadesOperacionMenuText());
        return { replies, notifyAgent, session: s };
      }

      s.data.op = op;

      if (op === "vender") {
        s.step = "prop_vender_tipo";
        replies.push(
          "🧾 ¿Qué *tipo de propiedad* querés vender? (casa, depto, local, etc.)"
        );
      } else {
        s.step = "prop_tipo_menu";
        replies.push(propiedadesTipoMenuText(op));
      }
      return { replies, notifyAgent, session: s };
    }
    case "prop_tipo_menu": {
      const tipo = normalizePropType(bodyRaw);
      if (!tipo) {
        replies.push(propiedadesTipoMenuText(s.data.op || "alquilar"));
        return { replies, notifyAgent, session: s };
      }

      // Si puso "otro" y no escribió nada más, pedile tipo libre
      if (tipo === "otro") {
        s.step = "prop_buscar_tipo";
        replies.push(
          "Decime el *tipo de propiedad* (ej.: local, duplex, loft, cabaña…):"
        );
        return { replies, notifyAgent, session: s };
      }

      // Tipo reconocido o texto libre → avanzamos
      s.data.prop = { tipo, op: s.data.op || "alquilar" };
      s.step = "prop_presupuesto";
      replies.push("💰 Indicá *presupuesto aproximado* (ej: 250000):");
      return { replies, notifyAgent, session: s };
    }

    case "prop_buscar_tipo": {
      s.data.prop = { tipo: bodyRaw, op: s.data.op || "alquilar" };
      s.step = "prop_presupuesto";
      replies.push(
        "💰 Indicá *presupuesto aproximado* (solo número). Después te pregunto la moneda."
      );
      break;
    }
    case "prop_presupuesto": {
      const p = num(bodyRaw);
      if (!p || p <= 0) {
        replies.push("Valor inválido. Probá de nuevo (solo números, sin $).");
      } else {
        s.data.prop = s.data.prop || { op: s.data.op || "alquilar" };
        s.data.prop.presupuesto = p;
        s.step = "prop_moneda"; // ← NUEVO paso
        replies.push(currencyMenuText("presupuesto"));
      }
      break;
    }
    case "prop_moneda": {
      const cur = parseCurrency(bodyRaw);
      if (!cur) {
        replies.push(currencyMenuText("presupuesto"));
      } else {
        s.data.prop.moneda = cur; // "ARS" | "USD"
        s.step = "prop_zona";
        replies.push("📍 Zona / barrio preferido:");
      }
      break;
    }
    case "prop_zona": {
      const zona = asOptionalText(bodyRaw);
      s.data.prop.zona = zona; // null => sin filtro
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
      s.data.prop.comodidades = asOptionalText(bodyRaw);

      const cur = s.data.prop.moneda || "ARS";
      const budget = Number(s.data.prop.presupuesto || 0);

      let resp = await searchProperties({
        opText: s.data.prop.op,
        tipoText: s.data.prop.tipo,
        cityText: s.data.prop.zona,
        perPage: 30,
        page: 1,
        budget,
        currency: cur,
        tolerancePct: 15,
      });

      if (!resp.results.length && s.data.prop.zona) {
        resp = await searchProperties({
          opText: s.data.prop.op,
          tipoText: s.data.prop.tipo,
          cityText: null,
          perPage: 30,
          page: 1,
          budget,
          currency: cur,
          tolerancePct: 15,
        });
      }

      const filtered = resp.results.slice(0, 5);

      if (!filtered.length) {
        replies.push(
          "No encontré coincidencias con esos filtros en este momento. " +
            "¿Querés ampliar presupuesto / cambiar zona / o hablar con un asesor? (sí/no)"
        );
        s.step = "prop_buscar_derivar";
        break;
      }

      // 👇 NUEVO: data UI para Webchat (cards)
      const ui = {
        cards: filtered.map((p) => ({
          id: p.id,
          title: p.title,
          priceText: fmtAmount(p.price, p.currency),
          excerpt: p.excerpt || "",
          image: p.image || null,
          link: p.link,
        })),
      };

      replies.push(
        `Perfecto 🙌 Con tu presupuesto de *${fmtAmount(budget, cur)}* en *${
          s.data.prop.zona || "la zona que indiques"
        }*, estas son las mejores oportunidades que encontré:`
      );

      // WhatsApp / fallback: seguimos mandando texto
      for (const p of filtered) replies.push(fmtPropCard(p));

      replies.push(
        "¿Querés que un asesor te contacte para coordinar visita? (sí/no)"
      );
      s.step = "prop_buscar_derivar";

      // ✅ IMPORTANT: retornar UI junto con replies
      return { replies, notifyAgent, session: s, ui };
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

module.exports = {
  handleText,
  handleImage,
  reset,
  getSession,
  engineExitAI,
  engineTouchAI,
};
