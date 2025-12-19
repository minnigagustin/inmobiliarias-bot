// wpProperties.js
const WP_BASE = process.env.WP_BASE || "https://lginmobiliaria.com.ar";

async function fetchJSON(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "BRGroupBot/1.0" },
  });
  if (!r.ok) throw new Error(`WP error ${r.status} ${await r.text()}`);
  return r.json();
}

// Normaliza un item del WP a algo “usable” por el bot
function mapProperty(p) {
  const meta = p.property_meta || {};
  const price = Number(meta.REAL_HOMES_property_price || 0);
  const prefix = (meta.REAL_HOMES_property_price_prefix || "").toUpperCase();
  const currency = /U\$S|USD|US\$/.test(prefix) ? "USD" : "ARS";

  return {
    id: p.id,
    title: p.title?.rendered?.replace(/&#8211;/g, "–") || "Propiedad",
    link: p.link,
    typeIds: p["tipos-propiedad"] || [],
    opIds: p["operaciones-propiedad"] || [],
    cityIds: p["ciudades-propiedad"] || [],
    bedrooms: Number(meta.REAL_HOMES_property_bedrooms || 0),
    bathrooms: Number(meta.REAL_HOMES_property_bathrooms || 0),
    garage: Number(meta.REAL_HOMES_property_garage || 0),
    size: Number(meta.REAL_HOMES_property_size || 0),
    lot: Number(meta.REAL_HOMES_property_lot_size || 0),
    price,
    currency,
    address: meta.REAL_HOMES_property_address || "",
    excerpt: (p.excerpt?.rendered || "").replace(/<[^>]+>/g, "").trim(),
    images: (meta.REAL_HOMES_property_images || [])
      .map((img) => img.full_url)
      .filter(Boolean),
  };
}

// Busca con parámetros “core” (search, pagination). Filtros finos los hacemos en Node.
async function searchProperties({ search = "", perPage = 20, page = 1 } = {}) {
  const url = new URL(`${WP_BASE}/wp-json/wp/v2/propiedades`);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  url.searchParams.set(
    "_fields",
    [
      "id",
      "link",
      "title",
      "excerpt",
      "property_meta",
      "tipos-propiedad",
      "operaciones-propiedad",
      "ciudades-propiedad",
    ].join(",")
  );

  // “search” en WP busca por título/contenido (útil para zona si la escriben en el post)
  if (search) url.searchParams.set("search", search);

  const data = await fetchJSON(url.toString());
  return data.map(mapProperty);
}

module.exports = { searchProperties };
