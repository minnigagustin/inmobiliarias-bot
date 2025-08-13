// nlu_pre.js — normalización + patrones con es-compromise (capa 1)
const deburr = require("lodash.deburr");
const nlp = require("es-compromise");

function norm(s) {
  return deburr(String(s || "").toLowerCase()).trim();
}

function detectIndex(doc) {
  const t = doc.text("normal");
  if (/\bicl\b/.test(t)) return "ICL";
  if (/\bcac\b/.test(t)) return "CAC";
  if (/\buva\b/.test(t)) return "UVA";
  if (/\buvi\b/.test(t)) return "UVI";
  if (/\bcer\b/.test(t)) return "CER";
  if (/casa propia/.test(t)) return "CASA_PROPIA";
  if (/ipc.*indec.*2/.test(t)) return "IPC_INDEC_2M";
  if (/ipc.*indec.*1/.test(t)) return "IPC_INDEC_1M";
  if (/ipc.*creebba.*2/.test(t)) return "IPC_CREEBBA_2M";
  if (/ipc.*creebba.*1/.test(t)) return "IPC_CREEBBA_1M";
  return null;
}

function detectBudget(doc, raw) {
  const nums = doc.numbers().out("array");
  const pick = nums.find((n) => String(n).length >= 4);
  if (pick) return Number(String(pick).replace(/\D/g, ""));
  const rx = raw.match(/(?:\$|ars|\b)\s*([\d\.]{4,})/i);
  return rx ? Number(rx[1].replace(/\./g, "")) : null;
}

function detectIssueCategory(doc) {
  doc.compute("root");
  const rootTxt = doc.text("root");
  if (/(canilla|agua|gote|perdida|perder|inund)/.test(rootTxt))
    return "Plomería";
  if (/\bgas\b/.test(rootTxt)) return "Gas";
  if (/(electric|corto|chispa|enchufe|luz)/.test(rootTxt))
    return "Electricidad";
  if (/(artefacto|termotan|calefon|heladera|cocina|horno)/.test(rootTxt))
    return "Artefacto roto";
  return null;
}

function preIntent(text) {
  const raw = String(text || "");
  const doc = nlp(norm(raw));

  // cortesía
  if (doc.has("(gracias|genial|perfecto)")) return { intent: "thanks" };
  if (doc.has("(chau|adios|hasta luego)")) return { intent: "goodbye" };

  if (doc.has("(operador|humano|asesor)")) return { intent: "operator" };
  if (doc.has("(hola|buen dia|buenas|menu|inicio|start)"))
    return { intent: "greeting" };

  // 🔎 DUEÑO: cobrar/liquidación/rendición (prioritario)
  if (
    doc.has(
      "(como cobro|cómo cobro|cobrar|cobro|liquidación|liquidacion|rendición|rendicion)"
    )
  ) {
    if (
      !doc.has("(quiero alquilar|busco alquiler|necesito alquilar|alquilar)")
    ) {
      return { intent: "owner_info" };
    }
  }

  // problemas/roturas
  if (
    doc.has(
      "(romper|gote|fuga|perdida|corto|chispa|no funciona|no andar|canilla|inund|gas|enchufe|luz|artefacto)"
    )
  ) {
    return {
      intent: "report_issue",
      slots: { category: detectIssueCategory(doc) },
    };
  }

  // índices
  const idx = detectIndex(doc);
  if (idx || doc.has("(indice|actualizar alquiler|ajuste)")) {
    return { intent: "index_update", slots: { index: idx } };
  }

  // propiedades — exigir verbo/frase, no solo el sustantivo “alquiler”
  if (doc.has("(alquilar|quiero alquilar|busco alquiler|necesito alquilar)"))
    return { intent: "properties_rent" };
  if (doc.has("(comprar|quiero comprar|busco comprar)"))
    return { intent: "properties_buy" };
  if (doc.has("(temporario|por dia|por semana)"))
    return { intent: "properties_temp" };
  if (doc.has("(vender|venta|tasaci)")) return { intent: "properties_sell" };

  // pista de presupuesto
  const budget = detectBudget(doc, raw);
  if (budget) return { hint: { budget } };

  return null;
}

module.exports = { preIntent };
