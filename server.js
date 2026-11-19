const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function normalizeKey(str) {
  return String(str || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

function normalizeUrl(rawUrl) {
  const u = String(rawUrl || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  return "https://" + u;
}

function extractContacts(tags = {}) {
  const phone = String(
    tags.phone || tags["contact:phone"] || tags["phone:mobile"] || ""
  ).trim();
  let whatsapp = String(
    tags["contact:whatsapp"] || tags.whatsapp || ""
  ).trim();
  if (!whatsapp && phone && /^(\+?39\s*)?3\d{8,9}$/.test(phone.replace(/\s+/g, ""))) {
    whatsapp = phone;
  }
  const website = normalizeUrl(
    tags.website || tags["contact:website"] || tags.url || ""
  );
  const email = String(tags.email || tags["contact:email"] || "").trim();
  return { phone, whatsapp, website, email };
}

function isFoodFeature(props = {}) {
  const val = String(props.osm_value || "").toLowerCase();
  const key = String(props.osm_key || "").toLowerCase();
  const type = String(props.type || "").toLowerCase();
  const allowed = [
    "restaurant",
    "pizzeria",
    "trattoria",
    "osteria",
    "cafe",
    "bar",
    "fast_food",
    "pub",
    "bistro",
    "ice_cream",
    "bakery",
    "food_court"
  ];
  if (allowed.includes(val) || allowed.includes(type)) return true;
  if (key === "amenity" && ["restaurant", "cafe", "bar", "fast_food", "pub", "ice_cream"].includes(val)) {
    return true;
  }
  return false;
}

async function fetchJsonSafe(url, headers = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...headers
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

async function searchPhoton(citta, zona = "") {
  const baseQueries = zona
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

  for (const q of baseQueries) {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=50`;
    const data = await fetchJsonSafe(url, {}, 5500);
    const features = data && Array.isArray(data.features) ? data.features : [];

    for (const f of features) {
      const p = f.properties || {};
      const name = String(p.name || "").trim();
      if (!name) continue;

      const country = String(p.countrycode || "").toUpperCase();
      if (country && country !== "IT") continue;
      if (!isFoodFeature(p)) continue;

      const cityProp = String(p.city || p.town || p.village || "").toLowerCase();
      if (cityProp && wantedCity && !cityProp.includes(wantedCity) && !wantedCity.includes(cityProp)) {
        continue;
      }

      const streetLine = [p.street, p.housenumber].filter(Boolean).join(" ");
      const kind = p.osm_value || p.type || "restaurant";
      const info = [streetLine, `OSM: ${kind}`].filter(Boolean).join(" • ");
      const detectedZone = zona || p.district || p.locality || p.suburb || "Centro";
      const contacts = extractContacts(p);

      items.push({
        nome: name,
        info,
        citta,
        zona: detectedZone,
        sito: contacts.website,
        telefono: contacts.phone,
        whatsapp: contacts.whatsapp,
        email: contacts.email
      });
    }
    if (items.length >= 100) break;
  }

  return items;
}

async function searchNominatimFallback(citta, zona = "") {
  const queries = zona
    ? [`restaurant ${zona} ${citta}, Italia`, `pizzeria ${zona} ${citta}, Italia`]
    : [`restaurant ${citta}, Italia`, `pizzeria ${citta}, Italia`, `trattoria ${citta}, Italia`];

  const items = [];
  for (const q of queries) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&extratags=1&limit=40`;
    const data = await fetchJsonSafe(
      url,
      { "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/1.0" },
      6500
    );
    if (!Array.isArray(data)) continue;

    for (const row of data) {
      const name = String(row.name || "").split(",")[0].trim();
      if (!name) continue;
      const addr = row.address || {};
      const extra = row.extratags || {};
      const streetLine = [addr.road || addr.pedestrian, addr.house_number].filter(Boolean).join(" ");
      const cuisine = extra.cuisine ? `Cucina: ${extra.cuisine}` : `Tipo: ${row.type || "restaurant"}`;
      const info = [streetLine, addr.postcode ? `CAP ${addr.postcode}` : "", cuisine]
        .filter(Boolean)
        .join(" • ");
      const contacts = extractContacts(extra);

      items.push({
        nome: name,
        info,
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

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "vocalis-estrattore-ristoranti", timestamp: new Date().toISOString() });
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
    let pool = await searchPhoton(citta, zona);

    if (pool.length < 15) {
      const nomPool = await searchNominatimFallback(citta, zona);
      pool = [...pool, ...nomPool];
    }

    const deduped = [];
    const seen = new Set();

    for (const item of pool) {
      const key = normalizeKey(item.nome);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
      if (deduped.length >= limit) break;
    }

    return res.json({
      citta,
      zona: zona || "Tutte",
      count: deduped.length,
      items: deduped
    });
  } catch (err) {
    return res.status(500).json({ error: "Errore durante l'estrazione dei locali.", details: err.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Vocalis Lead Extractor in ascolto sulla porta ${PORT}`);
});
