const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

const CITY_BBOX = {
  roma: "41.78,12.38,42.02,12.62",
  milano: "45.40,9.08,45.54,9.28",
  parma: "44.72,10.22,44.88,10.42",
  napoli: "40.78,14.16,40.92,14.35",
  torino: "45.00,7.58,45.14,7.77",
  bologna: "44.44,11.25,44.55,11.42",
  firenze: "43.72,11.18,43.83,11.34",
  genova: "44.38,8.82,44.48,9.04",
  palermo: "38.06,13.26,38.20,13.42",
  bari: "41.05,16.80,41.16,16.95",
  cerveteri: "41.96,12.04,42.05,12.16",
  ladispoli: "41.93,12.04,41.98,12.12"
};

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
  if (!low) return true;
  const blocked = [
    "tripadvisor.", "yelp.", "thefork.", "justeat.", "deliveroo.",
    "ubereats.", "glovoapp.", "openstreetmap.org", "wikipedia.org",
    "wikidata.org", "duckduckgo.com", "bing.com", "microsoft.com",
    "google.", "facebook.com", "instagram.com", "tiktok.com", "youtube.com"
  ];
  return blocked.some((b) => low.includes(b));
}

function isRestaurantOrPizzeria(name = "", amenity = "", cuisine = "") {
  const aLow = normalizeText(amenity);
  const cLow = normalizeText(cuisine);
  const nLow = normalizeText(name);

  if (["bar", "pub", "cafe", "ice_cream", "biergarten"].includes(aLow)) {
    return false;
  }
  return (
    aLow === "restaurant" ||
    cLow.includes("pizza") ||
    nLow.includes("pizzeria") ||
    nLow.includes("pizza") ||
    nLow.includes("ristorante") ||
    nLow.includes("trattoria") ||
    nLow.includes("osteria")
  );
}

function extractCap(postcode = "", infoText = "") {
  const direct = String(postcode || "").match(/\b\d{5}\b/);
  if (direct) return direct[0];
  const fromInfo = String(infoText || "").match(/\bCAP\s*(\d{5})\b/i);
  if (fromInfo) return fromInfo[1];
  return "99999";
}

function cleanPhone(raw) {
  return String(raw || "").replace(/[\s\-().]/g, "").trim();
}

function formatItalianPhone(phoneStr) {
  const cleaned = cleanPhone(phoneStr);
  if (!cleaned) return "";
  if (cleaned.startsWith("+") && !cleaned.startsWith("+39") && !cleaned.startsWith("0039")) {
    return "";
  }
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
    whatsapp = formatItalianMobile(whatsapp) || "";
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

// Divide un bounding box (south,west,north,east) in 4 quadranti per estrarre piu' dati senza timeout
function splitBboxIntoFour(bboxStr) {
  const parts = String(bboxStr || "").split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return [bboxStr];
  }
  const [s, w, n, e] = parts;
  const midLat = (s + n) / 2;
  const midLon = (w + e) / 2;
  return [
    `${s},${w},${midLat},${midLon}`,
    `${s},${midLon},${midLat},${e}`,
    `${midLat},${w},${n},${midLon}`,
    `${midLat},${midLon},${n},${e}`
  ];
}

async function fetchJsonSafe(url, options = {}, timeoutMs = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const txt = await res.text();
    if (!txt) return null;
    return JSON.parse(txt);
  } catch {
    clearTimeout(timer);
    return null;
  }
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
          "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/OSM-All"
        },
        body: "data=" + encodeURIComponent(overpassQuery)
      },
      18000
    );

    const elements = data && Array.isArray(data.elements) ? data.elements : [];
    if (elements.length > 0) return elements;
  }
  return [];
}

function mapOverpassElements(elements, citta, zonaRichiesta) {
  const items = [];
  for (const el of elements) {
    const tags = el.tags || {};
    const name = String(tags.name || "").trim();
    if (!name) continue;

    if (!isRestaurantOrPizzeria(name, tags.amenity || "", tags.cuisine || "")) {
      continue;
    }

    const cap = extractCap(tags["addr:postcode"] || "", "");
    const contacts = extractContacts(tags);
    const detectedZone =
      tags["addr:suburb"] ||
      tags["addr:neighbourhood"] ||
      tags["addr:city_district"] ||
      tags["addr:street"] ||
      zonaRichiesta ||
      "Centro";

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
      info: info || "Ristorante / Pizzeria",
      citta,
      zona: zonaRichiesta || detectedZone,
      cap,
      sito: contacts.website,
      telefono: contacts.phone,
      whatsapp: contacts.whatsapp,
      email: contacts.email
    });
  }
  return items;
}

async function getBboxForCity(citta) {
  const key = normalizeText(citta);
  if (CITY_BBOX[key]) return CITY_BBOX[key];

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(citta + ", Italia")}&format=jsonv2&countrycodes=it&limit=1`;
  const data = await fetchJsonSafe(
    url,
    { headers: { "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/OSM-All" } },
    8000
  );
  if (Array.isArray(data) && data[0] && Array.isArray(data[0].boundingbox) && data[0].boundingbox.length === 4) {
    const [south, north, west, east] = data[0].boundingbox;
    return `${south},${west},${north},${east}`;
  }
  return null;
}

async function searchOpenStreetMapAll(citta, zona = "", limit = 2000) {
  const cityEsc = citta.replace(/"/g, '\\"');
  const zoneVariants = buildZoneVariants(zona);
  const zoneRegex = zoneVariants.map((z) => z.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const perBoxCap = 2500;
  const bbox = await getBboxForCity(citta);

  if (bbox) {
    const boxes = zona ? [bbox] : splitBboxIntoFour(bbox);

    const lists = await Promise.all(
      boxes.map(async (subBox) => {
        const q = zona
          ? `
[out:json][timeout:25];
(
  node["amenity"="restaurant"]["name"~"${zoneRegex}",i](${subBox});
  way["amenity"="restaurant"]["name"~"${zoneRegex}",i](${subBox});
  node["amenity"="restaurant"]["addr:street"~"${zoneRegex}",i](${subBox});
  node["amenity"="restaurant"]["addr:suburb"~"${zoneRegex}",i](${subBox});
  node["cuisine"~"pizza",i]["name"~"${zoneRegex}",i](${subBox});
);
out center tags ${perBoxCap};
`.trim()
          : `
[out:json][timeout:25];
(
  node["amenity"="restaurant"]["name"](${subBox});
  way["amenity"="restaurant"]["name"](${subBox});
  node["cuisine"~"pizza",i]["name"](${subBox});
  way["cuisine"~"pizza",i]["name"](${subBox});
);
out center tags ${perBoxCap};
`.trim();

        const els = await runOverpassQuery(q);
        return mapOverpassElements(els, citta, zona);
      })
    );

    return lists.flat();
  }

  const q = `
[out:json][timeout:25];
area["name"~"^${cityEsc}$",i]->.a;
(
  node["amenity"="restaurant"]["name"](area.a);
  way["amenity"="restaurant"]["name"](area.a);
  node["cuisine"~"pizza",i]["name"](area.a);
  way["cuisine"~"pizza",i]["name"](area.a);
);
out center tags ${perBoxCap};
`.trim();

  const els = await runOverpassQuery(q);
  return mapOverpassElements(els, citta, zona);
}

function mergeSortByCapAndDeduplicate(items = [], limit = 2000) {
  const byKey = new Map();

  for (const item of items) {
    const key = normalizeKey(item.nome);
    if (!key) continue;

    const cap = extractCap(item.cap, item.info);

    if (!byKey.has(key)) {
      byKey.set(key, { ...item, cap });
    } else {
      const existing = byKey.get(key);
      if (existing.cap === "99999" && cap !== "99999") existing.cap = cap;
      if (!existing.sito && item.sito) existing.sito = item.sito;
      if (!existing.telefono && item.telefono) existing.telefono = item.telefono;
      if (!existing.whatsapp && item.whatsapp) existing.whatsapp = item.whatsapp;
      if (!existing.email && item.email) existing.email = item.email;
      if ((!existing.info || existing.info.length < 20) && item.info && item.info.length > existing.info.length) {
        existing.info = item.info;
      }
    }
  }

  const all = Array.from(byKey.values());
  all.sort((a, b) => {
    const capA = String(a.cap || "99999");
    const capB = String(b.cap || "99999");
    if (capA !== capB) return capA.localeCompare(capB, "it");
    return String(a.nome || "").localeCompare(String(b.nome || ""), "it");
  });

  return all.slice(0, limit);
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "vocalis-estrattore-osm-all",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/restaurants", async (req, res) => {
  try {
    const cittaRaw = String(req.query.citta || "").trim();
    const zona = String(req.query.zona || "").trim();
    const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit || "2000", 10) || 2000));

    if (!cittaRaw) {
      return res.status(400).json({ error: "Parametro 'citta' obbligatorio." });
    }

    const citta = cittaRaw.charAt(0).toUpperCase() + cittaRaw.slice(1);
    const rawItems = await searchOpenStreetMapAll(citta, zona, limit);
    const items = mergeSortByCapAndDeduplicate(rawItems, limit);

    return res.json({
      citta,
      zona: zona || "Tutte",
      count: items.length,
      items
    });
  } catch (err) {
    return res.status(500).json({ error: "Errore durante l'estrazione da OpenStreetMap.", details: err.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Vocalis Lead Extractor (OSM All) in ascolto sulla porta ${PORT}`);
});
