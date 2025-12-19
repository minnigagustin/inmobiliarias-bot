// wpProperties.js — PRO sin endpoint custom (solo WP REST v2)
const WP_BASE = process.env.WP_BASE || "https://lginmobiliaria.com.ar";
const WP_TIMEOUT_MS = Number(process.env.WP_TIMEOUT_MS || 9000);
const CACHE_TTL_MS = Number(process.env.WP_CACHE_TTL_MS || 10 * 60 * 1000);

// REST bases (según tus endpoints)
const TAX_TIPO = "tipos-propiedad";
const TAX_CITY = "ciudades-propiedad";
const TAX_OP = "operaciones-propiedad";

const CPT = "propiedades";

async function fetchJSON(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), WP_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "BRGroupBot/1.0" },
      signal: ctl.signal,
    });
    if (!r.ok)
      throw new Error(`WP ${r.status}: ${await r.text().catch(() => "")}`);
    // Guardamos total para paginado si querés
    const total = Number(r.headers.get("X-WP-Total") || 0);
    const totalPages = Number(r.headers.get("X-WP-TotalPages") || 0);
    const data = await r.json();
    return { data, total, totalPages };
  } finally {
    clearTimeout(t);
  }
}

// ----------------- Normalización -----------------
function deburr(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
function norm(str) {
  return deburr(str).toLowerCase().trim();
}
function scoreMatch(query, candidate) {
  const q = norm(query);
  const c = norm(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.includes(q)) return 70;
  if (q.includes(c)) return 60;
  const qt = new Set(q.split(/\s+/).filter(Boolean));
  const ct = new Set(c.split(/\s+/).filter(Boolean));
  let common = 0;
  for (const w of qt) if (ct.has(w)) common++;
  return common ? 20 + common * 10 : 0;
}

// ----------------- Cache TTL -----------------
const _cache = new Map(); // key -> { exp, value }
function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    _cache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  _cache.set(key, { exp: Date.now() + ttl, value });
}

// ----------------- Terms index -----------------
async function getTermsIndex(taxonomy) {
  const key = `terms:${taxonomy}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  // traemos muchos términos una vez
  const url = new URL(`${WP_BASE}/wp-json/wp/v2/${taxonomy}`);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("_fields", "id,slug,name");

  const { data } = await fetchJSON(url.toString());
  const list = (Array.isArray(data) ? data : []).map((t) => ({
    id: t.id,
    slug: t.slug,
    name: t.name,
  }));

  const idx = { taxonomy, list };
  cacheSet(key, idx);
  return idx;
}

function bestTermMatch(text, idx) {
  if (!text) return null;
  let best = null;
  let bestScore = 0;
  for (const t of idx.list) {
    const s = Math.max(scoreMatch(text, t.name), scoreMatch(text, t.slug));
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  return bestScore >= 50 ? best : null;
}

// ----------------- Moneda desde strings -----------------
function detectCurrency(val) {
  const t = norm(val);
  if (!t) return null;
  if (t.includes("usd") || t.includes("u$s") || t.includes("us$")) return "USD";
  if (t.includes("ars") || t.includes("$")) return "ARS";
  return null;
}

// ----------------- Extraer precio desde meta/ACF -----------------
// IMPORTANTE: esto depende de cómo esté armado tu CPT.
// - Si ACF expone campos en REST, puede venir en `acf`.
// - Si lo guardan como meta, puede venir en `meta`.
// Ajustá las claves acá.
function extractPrice(p) {
  const acf = p?.acf || null;
  const meta = p?.meta || null;
  const pm = p?.property_meta || null;

  const rawPrice =
    (acf && (acf.price || acf.precio || acf.property_price)) ??
    (meta && (meta.price || meta.precio || meta.property_price)) ??
    (pm &&
      (pm.REAL_HOMES_property_price || pm.REAL_HOMES_property_old_price)) ??
    null;

  const rawPrefix =
    (acf && (acf.price_prefix || acf.moneda || acf.currency)) ??
    (meta && (meta.price_prefix || meta.moneda || meta.currency)) ??
    (pm &&
      (pm.REAL_HOMES_property_price_prefix ||
        pm.REAL_HOMES_property_price_postfix)) ??
    p?.price_prefix ??
    null;

  const priceNum = Number(String(rawPrice || "").replace(/[^\d]/g, "")) || 0;
  const currency = detectCurrency(rawPrefix) || null;

  return { price: priceNum, currency, prefix: rawPrefix || "" };
}

// ----------------- Map WP post a objeto simple -----------------
function mapProperty(p) {
  const { price, currency, prefix } = extractPrice(p);
  return {
    id: p.id,
    title: p?.title?.rendered ? stripHtml(p.title.rendered) : "Propiedad",
    link: p.link,
    excerpt: p?.excerpt?.rendered ? stripHtml(p.excerpt.rendered) : "",
    featured_media: p.featured_media,
    price,
    currency: currency || "ARS",
    price_prefix: prefix,
    raw: p,
  };
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, "")
    .trim();
}

// ----------------- Búsqueda principal -----------------
async function searchProperties({
  opText, // ej "alquilar", "venta", "comprar"
  tipoText, // ej "depto", "casa"
  cityText, // ej "Punta Alta"
  perPage = 12,
  page = 1,
  budget,
  currency, // "ARS"|"USD"
  tolerancePct = 15,
  searchText, // opcional: fulltext WP ?search=
} = {}) {
  // 1) Resolver IDs de taxonomías (best match)
  const [tipoIdx, cityIdx, opIdx] = await Promise.all([
    getTermsIndex(TAX_TIPO),
    getTermsIndex(TAX_CITY),
    getTermsIndex(TAX_OP),
  ]);

  // Heurísticas para “depto”
  const tipoHint = (() => {
    const t = norm(tipoText);
    if (/depto|dpto|depart/.test(t)) return "departamento";
    if (/\bph\b/.test(t)) return "ph";
    return tipoText;
  })();

  // Heurística operación
  const opHint = (() => {
    const o = norm(opText);
    if (o === "comprar") return "venta";
    if (o === "vender") return "venta";
    if (o === "alquilar") return "alquiler";
    return opText;
  })();

  const tipoTerm = bestTermMatch(tipoHint, tipoIdx);
  const cityTerm = cityText ? bestTermMatch(cityText, cityIdx) : null;
  const opTerm = bestTermMatch(opHint, opIdx);

  // 2) Armar query WP
  const url = new URL(`${WP_BASE}/wp-json/wp/v2/${CPT}`);
  url.searchParams.set("per_page", String(Math.min(100, Math.max(1, perPage))));
  url.searchParams.set("page", String(Math.max(1, page)));
  url.searchParams.set("_embed", "1"); // para traer imagen destacada y taxos
  url.searchParams.set("orderby", "date");
  url.searchParams.set("order", "desc");

  if (searchText) url.searchParams.set("search", String(searchText));

  // ⭐ filtros por taxonomía (IDs)
  if (tipoTerm?.id) url.searchParams.set(TAX_TIPO, String(tipoTerm.id));
  if (cityTerm?.id) url.searchParams.set(TAX_CITY, String(cityTerm.id));
  if (opTerm?.id) url.searchParams.set(TAX_OP, String(opTerm.id));

  const { data, total, totalPages } = await fetchJSON(url.toString());
  const items = (Array.isArray(data) ? data : []).map(mapProperty);

  // 3) Filtros finos en Node (presupuesto/moneda)
  let filtered = items;

  if (currency) {
    filtered = filtered.filter(
      (x) => (x.currency || "").toUpperCase() === currency.toUpperCase()
    );
  }

  const b = Number(budget || 0);
  if (b > 0) {
    const max = b * (1 + Number(tolerancePct || 0) / 100);
    filtered = filtered.filter((x) => x.price > 0 && x.price <= max);
  }

  return {
    query: {
      tipo: tipoTerm || null,
      city: cityTerm || null,
      op: opTerm || null,
      url: url.toString(),
    },
    total,
    totalPages,
    results: filtered,
  };
}

module.exports = {
  searchProperties,
};
