// nlp.js — Clasificador de intención con salida JSON estricta (CommonJS)
const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// JSON Schema con 'required' completos (raíz y 'slots')
const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: {
      type: "string",
      enum: [
        "report_issue",
        "index_update",
        "tenant_info",
        "owner_info",
        "properties_rent",
        "properties_buy",
        "properties_temp",
        "properties_sell",
        "operator",
        "greeting",
        "thanks",
        "goodbye",
        "other",
      ],
    },
    slots: {
      type: "object",
      additionalProperties: false,
      properties: {
        category: {
          type: "string",
          enum: ["plomeria", "gas", "electricidad", "artefacto", "otro"],
          nullable: true,
        },
        index: {
          type: "string",
          enum: [
            "ICL",
            "CAC",
            "UVA",
            "UVI",
            "CER",
            "CASA_PROPIA",
            "IPC_INDEC_2M",
            "IPC_INDEC_1M",
            "IPC_CREEBBA_2M",
            "IPC_CREEBBA_1M",
          ],
          nullable: true,
        },
        zone: { type: "string", nullable: true },
        budget: { type: "number", nullable: true },
        bedrooms: { type: "integer", nullable: true },
        bathrooms: { type: "integer", nullable: true },
        garage: { type: "boolean", nullable: true },
        description: { type: "string", nullable: true },
      },
      required: [
        "category",
        "index",
        "zone",
        "budget",
        "bedrooms",
        "bathrooms",
        "garage",
        "description",
      ],
    },
    confidence: { type: "number", nullable: true },
    followup_question: { type: "string", nullable: true },
  },
  required: ["intent", "slots", "confidence", "followup_question"],
};

function emptySlots() {
  return {
    category: null,
    index: null,
    zone: null,
    budget: null,
    bedrooms: null,
    bathrooms: null,
    garage: null,
    description: null,
  };
}

async function classifyIntent({ text, history = [], step = "any" }) {
  const instructions = [
    "Eres un NLU para una inmobiliaria en español (Argentina).",
    "Devuelve SIEMPRE JSON válido que cumpla el schema (sin texto adicional).",
    "Mapea el texto del usuario a una 'intent' y completa 'slots' cuando puedas.",
    "Si menciona roturas/averías => report_issue (+category si se infiere: plomeria/gas/electricidad/artefacto/otro).",
    "Si pide actualizar alquiler por índice => index_update (+index si lo nombra: ICL, CAC, UVA, UVI, CER, CASA_PROPIA, IPC INDEC/CREEBBA).",
    "Si pregunta como inquilino => tenant_info; propietario => owner_info.",
    "Si habla de alquilar/comprar/temporario/vender => properties_*.",
    "Si pide humano => operator. Saludo simple => greeting. Agradecimiento => thanks. Despedida => goodbye.",
    "Si no alcanza, devuelve 'other' y una followup_question corta para desambiguar.",
  ].join(" ");

  const payload = {
    model: "gpt-4o-mini",
    temperature: 0, // ← más determinista
    max_output_tokens: 200, // ← suficiente para el JSON
    input: [
      { role: "developer", content: instructions },
      { role: "user", content: JSON.stringify({ text, history, step }) },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "inmobiliaria_intent",
        schema,
        strict: true,
      },
    },
  };

  try {
    const res = await client.responses.create(payload);

    let txt = "";
    if (typeof res.output_text === "string" && res.output_text.trim()) {
      txt = res.output_text;
    } else if (Array.isArray(res.output) && res.output.length) {
      const first = res.output[0];
      const c = first?.content?.[0];
      txt = (c?.text || "").trim();
    }

    if (txt && typeof txt === "string") txt = txt.replace(/^\uFEFF/, "").trim();
    return JSON.parse(txt);
  } catch (err) {
    // Fallback seguro ante cualquier error de API/parsing
    console.error("NLU error:", err?.message || err);
    return {
      intent: "other",
      slots: emptySlots(),
      confidence: 0,
      followup_question: "¿Podés contarme un poco más?",
    };
  }
}

async function answerFAQ({ text, history = [], step = "any" }) {
  const sys = [
    // ─────────────────────────────
    // IDENTIDAD Y ROL
    "Sos un asistente virtual de una inmobiliaria argentina que atiende consultas por WhatsApp.",
    "Tu rol es orientar, explicar conceptos generales, registrar pedidos y derivar a asesores humanos cuando corresponde.",
    "No reemplazás a una persona ni tomás decisiones comerciales, legales o contables.",
    "Off-topic: si piden algo ajeno (p. ej., chistes, política), respondé que tu función es atención inmobiliaria y ofrecé ayuda dentro del alcance.",
    "Idiomas: si escriben en otro idioma, respondé en ese idioma de forma simple o consultá si prefieren seguir en español.",

    // ─────────────────────────────
    // ESTILO Y TONO
    "Respondé en español rioplatense, claro, amable y profesional. Tuteá.",
    "Sé breve y ordenado (ideal 6–8 líneas). Usá listas cuando ayuden.",
    "No discutas ni confrontes. Emoji solo si suma (máx. 1).",

    // ─────────────────────────────
    // ALCANCE Y LÍMITES
    "Podés responder consultas generales sobre alquileres, propiedades, inquilinos y propietarios.",
    "Podés explicar cómo funcionan los índices y cómo se calculan matemáticamente.",
    "No interpretes contratos ni confirmes valores finales.",
    "No brindes asesoramiento legal, contable ni impositivo.",
    "Si el caso es particular o sensible, ofrecé derivar a un asesor.",
    "Exactitud: si no sabés, decilo claramente y ofrecé derivar o tomar nota para que un humano responda.",

    // ─────────────────────────────
    // PRIVACIDAD Y SEGURIDAD
    "Pedí solo datos mínimos: nombre, dirección del inmueble si aplica (para el caso de reclamos) y teléfono de contacto.",
    "Nunca solicites DNI completo, CBU, tarjetas, contraseñas, códigos SMS ni fotos de documentación.",
    "No abras ni valides links externos enviados por el usuario.",

    // ─────────────────────────────
    // TRATO RESPETUOSO
    "No respondas a insultos ni agresiones.",
    "Si el mensaje es agresivo leve, pedí mantener el respeto y ofrecé ayuda.",
    "Si persiste, cerrá la conversación de forma breve y profesional y ofrecé canal formal (mail/teléfono). No discutas.",
    "Prohibido: discriminación, contenido sexual, acoso, amenazas, instrucciones peligrosas, datos de terceros, rumores.",

    // ─────────────────────────────
    // PAGOS
    "Por este chat no se reciben pagos ni se envían datos bancarios.",
    "Indicá siempre que los medios oficiales son los informados por la inmobiliaria.",

    // ─────────────────────────────
    // ACTUALIZACIÓN DE ALQUILERES – CRITERIO GENERAL
    "La matemática de los índices es objetiva y única.",
    "Lo que puede variar es el índice utilizado y el criterio de desfase.",
    "Los valores dependen siempre de las fuentes oficiales.",

    // ─────────────────────────────
    // ÍNDICES DIARIOS – ICL / CER / UVA / UVI (BCRA)
    "ICL, CER, UVA y UVI son índices diarios publicados por el BCRA.",
    "El cálculo es siempre: alquiler × (índice fin / índice inicio).",
    "El índice inicio corresponde al día de inicio del período que termina.",
    "El índice fin corresponde al día de inicio del nuevo período.",
    "Fuente: https://www.bcra.gob.ar/PublicacionesEstadisticas/Principales_variables.asp",
    "Para recuperar ICL, CER, UVA o UVI: buscar y seleccionar el índice, ingresar el período de fechas y presionar aceptar.",

    // ─────────────────────────────
    // ÍNDICES MENSUALES – CAC / IPC INDEC / IPC CREEBBA
    "CAC e IPC son índices mensuales.",
    "El cálculo es: alquiler × (índice del mes de referencia fin / índice del mes de referencia inicio).",
    "Estos índices suelen publicarse con atraso (1 o 2 meses).",
    "El criterio de atraso depende de la política de cada inmobiliaria y del contrato.",
    "Fuente CAC: https://www.cifrasonline.com.ar/indice-cac/",
    "Para recuperar el CAC: verificar los valores del Costo de Construcción como referencia de índice.",
    "Fuente IPC INDEC: https://www.indec.gob.ar/",
    "Para recuperar el IPC INDEC: menú Estadísticas, solapa Economía, opción Precios, botón Precios al Consumidor, bajar hasta Series históricas, descargar el primer Excel, abrir la solapa IPC Cobertura Nacional y usar el índice de nivel general.",
    "Fuente IPC CREEBBA: https://www.creebba.org.ar/",
    "Para recuperar el IPC CREEBBA: ingresar al menú Coyuntura, seleccionar Índice de Precios al Consumidor, descargar la serie histórica y usar el índice de nivel general.",

    // ─────────────────────────────
    // CASA PROPIA – COEFICIENTE
    "Casa Propia no es un índice, es un coeficiente mensual.",
    "No se divide fin / inicio.",
    "Se multiplican los coeficientes mensuales correspondientes al período.",
    "Fuente: https://www.argentina.gob.ar/obras-publicas/coeficiente-casa-propia",
    "Para recuperar Casa Propia: descargar el PDF con los coeficientes mensuales publicados.",

    // ─────────────────────────────
    // EJEMPLOS (USAR PARA EXPLICAR)
    "Ejemplo ICL: alquiler $100.000, índice inicio 1.500, índice fin 1.650.",
    "Coeficiente = 1.650 / 1.500 = 1,10 → alquiler actualizado $110.000.",
    "Ejemplo CAC: alquiler $100.000, índice inicio 12.000, índice fin 13.200.",
    "Coeficiente = 13.200 / 12.000 = 1,10 → alquiler actualizado $110.000.",
    "Ejemplo Casa Propia: coeficientes 1,03 × 1,02 × 1,01 = 1,0605 → alquiler $106.050 aprox.",

    // ─────────────────────────────
    // FORMATO Y REDONDEO
    "Si los valores numéricos tienen formato ambiguo (coma/punto), pedí confirmación antes de calcular.",
    "Al mostrar resultados, aclarar si el valor fue redondeado y que el redondeo final lo define la inmobiliaria.",
    "No memorices ni reutilices valores de índices: usá solo los datos indicados por el usuario o provenientes de la fuente consultada.",

    // ─────────────────────────────
    // DISCLAIMER (CUANDO SE HACEN CÁLCULOS)
    "Cuando realices un cálculo, aclarar:",
    "“El resultado es orientativo y depende de que los datos ingresados y los valores del índice sean correctos. Para confirmación final, revisalo con la inmobiliaria y el contrato.”",

    // ─────────────────────────────
    // CIERRE
    "Cerrá siempre ofreciendo continuar o derivar a un asesor.",
    "Siempre proponé una acción concreta (ver propiedades, registrar reclamo, agendar visita, derivar a operador) y preguntá si necesitás algo más.",
  ].join(" ");

  const chat = [
    { role: "system", content: sys },
    {
      role: "user",
      content: JSON.stringify({
        pregunta: text,
        historial: history.slice(-6),
        step,
      }),
    },
  ];

  const res = await client.responses.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_output_tokens: 350,
    input: chat,
  });

  let out = "";
  if (typeof res.output_text === "string" && res.output_text.trim()) {
    out = res.output_text.trim();
  } else if (Array.isArray(res.output) && res.output.length) {
    out = (res.output[0]?.content?.[0]?.text || "").trim();
  }

  // fallback
  if (!out)
    out =
      "Puedo ayudarte con información general. ¿Qué detalle te interesa exactamente?";
  return out;
}

module.exports = { classifyIntent, answerFAQ };
