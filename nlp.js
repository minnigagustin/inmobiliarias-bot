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
        "thanks", // <-- agregado
        "goodbye", // <-- agregado
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

async function classifyIntent({ text, history = [], step = "any" }) {
  const instructions = [
    "Eres un NLU para una inmobiliaria en español (Argentina).",
    "Devuelve SIEMPRE JSON válido que cumpla el schema (sin texto adicional).",
    "Mapea el texto del usuario a una 'intent' y completa 'slots' cuando puedas.",
    "Si menciona roturas/averías => report_issue (+category si se infiere: plomeria/gas/electricidad/artefacto/otro).",
    "Si pide actualizar alquiler por índice => index_update (+index si lo nombra: ICL, CAC, UVA, UVI, CER, CASA_PROPIA, IPC INDEC/CREEBBA).",
    "Si pregunta como inquilino => tenant_info; propietario => owner_info.",
    "Si habla de alquilar/comprar/temporario/vender => properties_*.",
    "Si pide humano => operator. Saludo simple => greeting.",
    "Si el usuario agradece => thanks. Si se despide => goodbye.",
    "Si no alcanza, devuelve 'other' y una followup_question corta para desambiguar.",
  ].join(" ");

  const payload = {
    model: "gpt-4o-mini",
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

  const res = await client.responses.create(payload);

  // Extraer el JSON devuelto como texto
  let txt = "";
  if (typeof res.output_text === "string" && res.output_text.trim()) {
    txt = res.output_text;
  } else if (Array.isArray(res.output) && res.output.length) {
    try {
      const first = res.output[0];
      const c = first?.content?.[0];
      txt = (c?.text || "").trim();
    } catch (_) {}
  }

  if (txt && typeof txt === "string") txt = txt.replace(/^\uFEFF/, "").trim();

  try {
    return JSON.parse(txt);
  } catch {
    return {
      intent: "other",
      slots: {},
      confidence: 0,
      followup_question: "¿Podés contarme un poco más?",
    };
  }
}

module.exports = { classifyIntent };
