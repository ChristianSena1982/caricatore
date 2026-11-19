const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function normalizeKey(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function normalizeUrl(rawUrl) {
  const u = String(rawUrl || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  return "https://" + u;
}

function cleanPhone(raw) {
  return String(raw || "").replace(/[\s\-().]/g, "").trim();
}

function isItalianMobile(phoneStr) {
  const digits = cleanPhone(phoneStr).replace(/^\+39/, "").replace(/^0039/, "");
  return /^3\d{8,9}$/.test(digits);
}

function formatItalianMobile(phoneStr) {
  const digits = cleanPhone(phoneStr).replace(/^\+39/, "").replace(/^0039/, "");
  if (/^3\d{8,9}$/.test(digits)) return "+39" + digits;
  return String(phoneStr || "").trim();
}

function extractContacts(tags = {}) {
  const phone = String(
    tags.phone ||
      tags["contact:phone"] ||
      tags["phone:mobile"] ||
      tags["contact:mobile"] ||
      ""
  ).trim();

  let whatsapp = String(
    tags["contact:whatsapp"] || tags.whatsapp || ""
  ).trim();

  if (!whatsapp && isItalianMobile(phone)) {
    whatsapp = formatItalianMobile(phone);
  } else if (whatsapp) {
    whatsapp = formatItalianMobile(whatsapp);
  }

  const website = normalizeUrl(
    tags.website ||
      tags["contact:website"] ||
      tags.url ||
      tags["contact:facebook"] ||
      tags["contact:instagram"] ||
      ""
  );

  const email = String(tags.email || tags["contact:email"] || "").trim();

  return { phone, whatsapp, website, email };
}

function buildInfoLine(parts = {}) {
  const street = [parts.street, parts.housenumber].filter(Boolean).join(" ").trim();
  const extraBits = [];
  if (parts.postcode) extraBits.push(`CAP ${parts.postcode}`);
  if (parts.cuisine) extraBits.push(`Cucina: ${String(parts.cuisine).replace(/_/g, " ")}`);
  if (parts.opening_hours) extraBits.push(`Orari: ${parts.opening_hours}`);
  if (parts.kind) extraBits.push(`Tipo: ${String(parts.kind).replace(/_/g, " ")}`);
  return [street, ...extraBits].filter(Boolean).join(" • ");
}

async function fetchJsonSafe(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function searchOverpass(citta, zona = "", limit = 100) {
  const cityEsc = citta.replace(/"/g, '\"');
  const zoneFilter = zona
    ? `["addr:suburb"~"${zona.replace(/"/g, '\"')}",i]`
    : "";

  const overpassQuery = `
[out:json][timeout:20];
(
  area["name"~"^${cityEsc}$",i]["boundary"~"administrative"]->.searchArea;
  (
    node["amenity"~"restaurant|cafe|bar|fast_food|pub|ice_cream"]${zoneFilter}(area.searchArea);
    way["amenity"~"restaurant|cafe|bar|fast_food|pub|ice_cream"]${zoneFilter}(area.searchArea);
  );
);
out center tags ${Math.min(limit * 2, 200)};
`.trim();

  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];

  for (const endpoint of endpoints) {
    const data = await fetchJsonSafe(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/2.0"
        },
        body: "data=" + encodeURIComponent(overpassQuery)
      },
      14000
    );

    const elements = data && Array.isArray(data.elements) ? data.elements : [];
    if (!elements.length) continue;

    const items = [];
    for (const el of elements) {
      const tags = el.tags || {};
      const name = String(tags.name || "").trim();
      if (!name) continue;

      const contacts = extractContacts(tags);
      const info = buildInfoLine({
        street: tags["addr:street"] || "",
        housenumber: tags["addr:housenumber"] || "",
        postcode: tags["addr:postcode"] || "",
        cuisine: tags.cuisine || "",
        opening_hours: tags.opening_hours || "",
        kind: tags.amenity || "restaurant"
      });

      items.push({
        nome: name,
        info: info || `Locale (${tags.amenity || "ristorazione"})`,
        citta,
        zona: zona || tags["addr:suburb"] || tags["addr:neighbourhood"] || tags["addr:city_district"] || "Centro",
        sito: contacts.website,
        telefono: contacts.phone,
        whatsapp: contacts.whatsapp,
        email: contacts.email
      });
    }

    if (items.length > 0) return items;
  }

  return [];
}

async function searchPhoton(citta, zona = "") {
  const queries = zona
    ? [
        `ristorante ${zona} ${citta}`,
        `pizzeria ${zona} ${citta}`,
        `trattoria ${zona} ${citta}`,
        `osteria ${zona} ${citta}`,
        `ristorante ${citta}`
      ]
    : [
        `ristorante ${citta}`,
        `pizzeria ${citta}`,
        `trattoria ${citta}`,
        `osteria ${citta}`,
        `ristoranti ${citta}`
      ];

  const items = [];
  const wantedCity = citta.toLowerCase().trim();

  for (const q of queries) {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=50`;
    const data = await fetchJsonSafe(url, {}, 6000);
    const features = data && Array.isArray(data.features) ? data.features : [];

    for (const f of features) {
      const p = f.properties || {};
      const name = String(p.name || "").trim();
      if (!name) continue;

      const country = String(p.countrycode || "").toUpperCase();
      if (country && country !== "IT") continue;

      const cityProp = String(p.city || p.town || p.village || "").toLowerCase();
      if (cityProp && wantedCity && !cityProp.includes(wantedCity) && !wantedCity.includes(cityProp)) {
        continue;
      }

      const contacts = extractContacts(p);
      const info = buildInfoLine({
        street: p.street || "",
        housenumber: p.housenumber || "",
        postcode: p.postcode || "",
        cuisine: p.cuisine || "",
        kind: p.osm_value || p.type || "restaurant"
      });

      items.push({
        nome: name,
        info: info || `Locale (${p.osm_value || "ristorazione"})`,
        citta,
        zona: zona || p.district || p.locality || p.suburb || "Centro",
        sito: contacts.website,
        telefono: contacts.phone,
        whatsapp: contacts.whatsapp,
        email: contacts.email
      });
    }
    if (items.length >= 120) break;
  }

  return items;
}

async function searchNominatim(citta, zona = "") {
  const queries = zona
    ? [`restaurant ${zona} ${citta}, Italia`, `pizzeria ${zona} ${citta}, Italia`]
    : [`restaurant ${citta}, Italia`, `pizzeria ${citta}, Italia`, `trattoria ${citta}, Italia`];

  const items = [];
  for (const q of queries) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&extratags=1&limit=40`;
    const data = await fetchJsonSafe(
      url,
      { headers: { "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/2.0" } },
      7000
    );
    if (!Array.isArray(data)) continue;

    for (const row of data) {
      const name = String(row.name || "").split(",")[0].trim();
      if (!name) continue;
      const addr = row.address || {};
      const extra = row.extratags || {};
      const contacts = extractContacts(extra);
      const info = buildInfoLine({
        street: addr.road || addr.pedestrian || "",
        housenumber: addr.house_number || "",
        postcode: addr.postcode || "",
        cuisine: extra.cuisine || "",
        opening_hours: extra.opening_hours || "",
        kind: row.type || "restaurant"
      });

      items.push({
        nome: name,
        info: info || `Locale (${row.type || "ristorazione"})`,
        citta,
        zona: zona || addr.suburb || addr.neighbourhood || addr.city_district || "Centro",
        sito: contacts.website,
        telefono: contacts.phone,
        whatsapp: contacts.whatsapp,
        email: contacts.email
      });
    }
    if (items.length >= 80) break;
  }

  return items;
}

function mergeAndDeduplicate(pools = [], limit = 100) {
  const byKey = new Map();

  for (const pool of pools) {
    for (const item of pool) {
      const key = normalizeKey(item.nome);
      if (!key) continue;

      if (!byKey.has(key)) {
        byKey.set(key, { ...item });
      } else {
        const existing = byKey.get(key);
        if (!existing.sito && item.sito) existing.sito = item.sito;
        if (!existing.telefono && item.telefono) existing.telefono = item.telefono;
        if (!existing.whatsapp && item.whatsapp) existing.whatsapp = item.whatsapp;
        if (!existing.email && item.email) existing.email = item.email;
        if ((!existing.info || existing.info.length < 15) && item.info && item.info.length > existing.info.length) {
          existing.info = item.info;
        }
        if ((!existing.zona || existing.zona === "Centro") && item.zona && item.zona !== "Centro") {
          existing.zona = item.zona;
        }
      }
    }
  }

  return Array.from(byKey.values()).slice(0, limit);
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "vocalis-estrattore-ristoranti-v2", timestamp: new Date().toISOString() });
});

app.get("/api/restaurants", async (req, res) => {
  try {
    const cittaRaw = String(req.query.citta || "").trim();
    const zona = String(req.query.zona || "").trim();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "100", 10) || 100));

    if (!cittaRaw) {
      return res.status(400).json({ error: "Parametro 'citta' obbligatorio." });
    }

    const citta = cittaRaw.charAt(0).toUpperCase() + cittaRaw.slice(1);

    const [overpassPool, photonPool] = await Promise.all([
      searchOverpass(citta, zona, limit),
      searchPhoton(citta, zona)
    ]);

    let pools = [overpassPool, photonPool];
    if (overpassPool.length + photonPool.length < Math.min(limit, 40)) {
      const nominatimPool = await searchNominatim(citta, zona);
      pools.push(nominatimPool);
    }

    const items = mergeAndDeduplicate(pools, limit);

    return res.json({
      citta,
      zona: zona || "Tutte",
      count: items.length,
      items
    });
  } catch (err) {
    return res.status(500).json({ error: "Errore durante l'estrazione dei locali.", details: err.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Vocalis Lead Extractor v2 in ascolto sulla porta ${PORT}`);
});
