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

function normalizeText(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function normalizeUrl(rawUrl) {
  const u = String(rawUrl || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  return "https://" + u;
}

function isJunkDomain(urlStr) {
  const low = String(urlStr || "").toLowerCase();
  return (
    !low ||
    low.includes("tripadvisor.") ||
    low.includes("yelp.") ||
    low.includes("thefork.") ||
    low.includes("justeat.") ||
    low.includes("deliveroo.") ||
    low.includes("ubereats.") ||
    low.includes("glovoapp.") ||
    low.includes("openstreetmap.org") ||
    low.includes("wikipedia.org") ||
    low.includes("wikidata.org") ||
    low.includes("duckduckgo.com") ||
    low.includes("bing.com") ||
    low.includes("microsoft.com") ||
    low.includes("google.") ||
    low.includes("facebook.com") ||
    low.includes("instagram.com") ||
    low.includes("tiktok.com") ||
    low.includes("youtube.com")
  );
}

function isInsideItaly(lat, lon, countryCode = "", addressText = "") {
  if (countryCode && String(countryCode).toUpperCase() !== "IT") {
    return false;
  }
  const numLat = Number(lat);
  const numLon = Number(lon);
  if (Number.isFinite(numLat) && Number.isFinite(numLon)) {
    if (numLat < 36.2 || numLat > 47.3 || numLon < 6.4 || numLon > 18.9) {
      return false;
    }
  }
  const lowAddr = normalizeText(addressText);
  const foreignHints = [
    "finland", "suomi", "germany", "deutschland", "canada", "austria",
    "switzerland", "schweiz", "france", "spain", "uk", "united kingdom",
    "usa", "united states", "matkuksentie", "lonsdale", "obergasse", "dompassage"
  ];
  if (foreignHints.some((fh) => lowAddr.includes(fh))) {
    return false;
  }
  return true;
}

function cleanPhone(raw) {
  return String(raw || "").replace(/[\s\-().]/g, "").trim();
}

function formatItalianPhone(phoneStr) {
  const cleaned = cleanPhone(phoneStr);
  if (!cleaned) return "";
  const digitsOnly = cleaned.replace(/[^\d+]/g, "");
  const noPrefix = digitsOnly.replace(/^\+39/, "").replace(/^0039/, "");
  if (/^3\d{8,9}$/.test(noPrefix)) return "+39 " + noPrefix;
  if (/^0\d{5,10}$/.test(noPrefix)) return noPrefix;
  return "";
}

function isItalianMobile(phoneStr) {
  const digits = cleanPhone(phoneStr).replace(/^\+39/, "").replace(/^0039/, "");
  return /^3\d{8,9}$/.test(digits);
}

function formatItalianMobile(phoneStr) {
  const digits = cleanPhone(phoneStr).replace(/^\+39/, "").replace(/^0039/, "");
  if (/^3\d{8,9}$/.test(digits)) return "+39" + digits;
  return "";
}

function extractContacts(tags = {}) {
  const rawPhone = String(
    tags.phone ||
      tags["contact:phone"] ||
      tags["phone:mobile"] ||
      tags["contact:mobile"] ||
      ""
  ).trim();

  const phone = formatItalianPhone(rawPhone);

  let whatsapp = String(
    tags["contact:whatsapp"] || tags.whatsapp || ""
  ).trim();

  if (whatsapp) {
    whatsapp = formatItalianMobile(whatsapp) || whatsapp;
  } else if (isItalianMobile(rawPhone)) {
    whatsapp = formatItalianMobile(rawPhone);
  }

  const candidateSite = normalizeUrl(
    tags.website ||
      tags["contact:website"] ||
      tags.url ||
      ""
  );
  const website = isJunkDomain(candidateSite) ? "" : candidateSite;

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

function buildZoneVariants(zona) {
  const clean = normalizeText(zona);
  if (!clean) return [];
  const variants = new Set([clean]);
  if (clean.endsWith("a") && clean.length > 4) {
    variants.add(clean.slice(0, -1) + "o");
  }
  if (clean.endsWith("o") && clean.length > 4) {
    variants.add(clean.slice(0, -1) + "a");
  }
  return Array.from(variants);
}

async function fetchTextSafe(url, options = {}, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function fetchJsonSafe(url, options = {}, timeoutMs = 9500) {
  const txt = await fetchTextSafe(
    url,
    {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
    },
    timeoutMs
  );
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function mapOverpassElements(elements, citta, zonaRichiesta) {
  const items = [];
  for (const el of elements) {
    const tags = el.tags || {};
    const name = String(tags.name || "").trim();
    if (!name) continue;

    const lat = el.lat || (el.center && el.center.lat);
    const lon = el.lon || (el.center && el.center.lon);
    const addrText = `${tags["addr:city"] || ""} ${tags["addr:street"] || ""} ${tags["addr:country"] || ""}`;
    if (!isInsideItaly(lat, lon, tags["addr:country"] || "IT", addrText)) continue;

    const detectedZone =
      tags["addr:suburb"] ||
      tags["addr:neighbourhood"] ||
      tags["addr:city_district"] ||
      tags["addr:quarter"] ||
      tags["addr:street"] ||
      zonaRichiesta ||
      "Centro";

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
      zona: zonaRichiesta || detectedZone,
      sito: contacts.website,
      telefono: contacts.phone,
      whatsapp: contacts.whatsapp,
      email: contacts.email
    });
  }
  return items;
}

async function runOverpassQuery(overpassQuery) {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
  ];

  for (const endpoint of endpoints) {
    const data = await fetchJsonSafe(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/13.0"
        },
        body: "data=" + encodeURIComponent(overpassQuery)
      },
      11000
    );

    const elements = data && Array.isArray(data.elements) ? data.elements : [];
    if (elements.length > 0) return elements;
  }
  return [];
}

// Query leggere divise per tipo di locale per evitare timeout sulle citta' grandi come Roma
async function searchOverpassFastChunks(citta, zona = "", limit = 100) {
  const cityEsc = citta.replace(/"/g, '\\"');
  const isRoma = normalizeText(citta) === "roma";
  const zoneVariants = buildZoneVariants(zona);
  const zoneRegex = zoneVariants.map((z) => z.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  const areaOrBbox = isRoma
    ? `(41.78,12.38,41.98,12.58)`
    : `(area["name"~"^${cityEsc}$",i]["admin_level"~"6|7|8"]->.a;.a)`;

  const amenityGroups = ["restaurant", "fast_food|cafe", "bar|pub|ice_cream"];

  const chunkPromises = amenityGroups.map(async (amen) => {
    let q;
    if (zona && isRoma) {
      q = `
[out:json][timeout:15];
(
  node["amenity"~"${amen}"]["name"~"${zoneRegex}",i](41.72,12.28,42.06,12.72);
  node["amenity"~"${amen}"]["addr:street"~"${zoneRegex}",i](41.72,12.28,42.06,12.72);
  node["amenity"~"${amen}"]["addr:suburb"~"${zoneRegex}",i](41.72,12.28,42.06,12.72);
);
out tags ${Math.min(limit * 2, 200)};
`.trim();
    } else if (isRoma) {
      q = `
[out:json][timeout:15];
node["amenity"~"${amen}"]["name"](41.78,12.38,41.98,12.58);
out tags ${Math.min(limit * 2, 200)};
`.trim();
    } else {
      q = `
[out:json][timeout:15];
area["name"~"^${cityEsc}$",i]["admin_level"~"6|7|8"]->.a;
node["amenity"~"${amen}"]["name"](area.a);
out tags ${Math.min(limit * 2, 200)};
`.trim();
    }

    void areaOrBbox;
    const els = await runOverpassQuery(q);
    return mapOverpassElements(els, citta, zona);
  });

  const results = await Promise.all(chunkPromises);
  return results.flat();
}

async function searchPhotonItalian(citta, zona = "") {
  const queries = zona
    ? [
        `ristorante ${zona} ${citta}`,
        `pizzeria ${zona} ${citta}`,
        `trattoria ${zona} ${citta}`,
        `osteria ${zona} ${citta}`,
        `bar ${zona} ${citta}`,
        `pub ${zona} ${citta}`
      ]
    : [
        `ristorante ${citta}`,
        `pizzeria ${citta}`,
        `trattoria ${citta}`,
        `osteria ${citta}`,
        `bar ${citta}`,
        `pub ${citta}`,
        `bistrot ${citta}`,
        `gelateria ${citta}`
      ];

  const wantedCity = normalizeText(citta);
  const zoneVariants = buildZoneVariants(zona);

  const queryPromises = queries.map(async (q) => {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=50`;
    const data = await fetchJsonSafe(url, {}, 5500);
    const features = data && Array.isArray(data.features) ? data.features : [];
    const out = [];

    for (const f of features) {
      const p = f.properties || {};
      const coords = (f.geometry && f.geometry.coordinates) || [];
      const lon = coords[0];
      const lat = coords[1];
      const name = String(p.name || "").trim();
      if (!name) continue;

      const addrString = `${p.city || ""} ${p.street || ""} ${p.country || ""}`;
      if (!isInsideItaly(lat, lon, p.countrycode || "", addrString)) continue;

      const cityProp = normalizeText(p.city || p.town || p.village || "");
      if (cityProp && !cityProp.includes(wantedCity) && !wantedCity.includes(cityProp)) {
        continue;
      }

      if (zoneVariants.length > 0) {
        const hay = normalizeText(
          `${name} ${p.street || ""} ${p.district || ""} ${p.locality || ""} ${p.suburb || ""}`
        );
        if (!zoneVariants.some((zv) => hay.includes(zv))) continue;
      }

      const contacts = extractContacts(p);
      const info = buildInfoLine({
        street: p.street || "",
        housenumber: p.housenumber || "",
        postcode: p.postcode || "",
        cuisine: p.cuisine || "",
        kind: p.osm_value || p.type || "restaurant"
      });

      out.push({
        nome: name,
        info: info || `Locale (${p.osm_value || "ristorazione"})`,
        citta,
        zona: zona || p.district || p.locality || p.suburb || p.street || "Centro",
        sito: contacts.website,
        telefono: contacts.phone,
        whatsapp: contacts.whatsapp,
        email: contacts.email
      });
    }

    return out;
  });

  const lists = await Promise.all(queryPromises);
  return lists.flat();
}

async function searchNominatimItalian(citta, zona = "") {
  const queries = zona
    ? [
        `restaurant ${zona} ${citta}, Italia`,
        `pizzeria ${zona} ${citta}, Italia`,
        `trattoria ${zona} ${citta}, Italia`,
        `bar ${zona} ${citta}, Italia`
      ]
    : [
        `restaurant ${citta}, Italia`,
        `pizzeria ${citta}, Italia`,
        `trattoria ${citta}, Italia`,
        `osteria ${citta}, Italia`,
        `bar ${citta}, Italia`
      ];

  const zoneVariants = buildZoneVariants(zona);

  const queryPromises = queries.map(async (q) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&extratags=1&countrycodes=it&limit=50`;
    const data = await fetchJsonSafe(
      url,
      { headers: { "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/13.0" } },
      6500
    );
    if (!Array.isArray(data)) return [];
    const out = [];

    for (const row of data) {
      const name = String(row.name || "").split(",")[0].trim();
      if (!name) continue;
      const addr = row.address || {};
      const extra = row.extratags || {};

      if (!isInsideItaly(row.lat, row.lon, addr.country_code || "it", row.display_name || "")) {
        continue;
      }

      if (zoneVariants.length > 0) {
        const hay = normalizeText(
          `${name} ${row.display_name || ""} ${addr.road || ""} ${addr.suburb || ""} ${addr.neighbourhood || ""}`
        );
        if (!zoneVariants.some((zv) => hay.includes(zv))) continue;
      }

      const contacts = extractContacts(extra);
      const info = buildInfoLine({
        street: addr.road || addr.pedestrian || "",
        housenumber: addr.house_number || "",
        postcode: addr.postcode || "",
        cuisine: extra.cuisine || "",
        opening_hours: extra.opening_hours || "",
        kind: row.type || "restaurant"
      });

      out.push({
        nome: name,
        info: info || `Locale (${row.type || "ristorazione"})`,
        citta,
        zona: zona || addr.suburb || addr.neighbourhood || addr.city_district || addr.road || "Centro",
        sito: contacts.website,
        telefono: contacts.phone,
        whatsapp: contacts.whatsapp,
        email: contacts.email
      });
    }

    return out;
  });

  const lists = await Promise.all(queryPromises);
  return lists.flat();
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
        if ((!existing.info || existing.info.length < 20) && item.info && item.info.length > existing.info.length) {
          existing.info = item.info;
        }
      }
    }
  }

  return Array.from(byKey.values()).slice(0, limit);
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "vocalis-estrattore-ristoranti-v13",
    timestamp: new Date().toISOString()
  });
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

    const [overpassPool, photonPool, nominatimPool] = await Promise.all([
      searchOverpassFastChunks(citta, zona, limit),
      searchPhotonItalian(citta, zona),
      searchNominatimItalian(citta, zona)
    ]);

    const items = mergeAndDeduplicate([overpassPool, photonPool, nominatimPool], limit);

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
  console.log(`Vocalis Lead Extractor v13 in ascolto sulla porta ${PORT}`);
});
