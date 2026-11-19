const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Prefissi CAP principali per controlli rapidi di coerenza (opzionali / estendibili)
const CITY_CAP_PREFIXES = {
  roma: ["001"],
  milano: ["201"],
  napoli: ["801"],
  torino: ["101"],
  bologna: ["401"],
  firenze: ["501"],
  parma: ["431"],
  genova: ["161"],
  palermo: ["901"],
  bari: ["701"],
  cerveteri: ["00052"],
  ladispoli: ["00055"]
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
  if (aLow === "restaurant") return true;
  if (
    cLow.includes("pizza") ||
    nLow.includes("pizzeria") ||
    nLow.includes("pizza") ||
    nLow.includes("ristorante") ||
    nLow.includes("trattoria") ||
    nLow.includes("osteria")
  ) {
    return true;
  }
  return false;
}

function extractCap(postcode = "", infoText = "") {
  const direct = String(postcode || "").match(/\b\d{5}\b/);
  if (direct) return direct[0];
  const fromInfo = String(infoText || "").match(/\bCAP\s*(\d{5})\b/i);
  if (fromInfo) return fromInfo[1];
  return "99999";
}

function isMatchingCityAndCap(citta, tags = {}, cap = "99999") {
  const cityKey = normalizeText(citta);
  const tagCity = normalizeText(tags["addr:city"] || "");
  const tagSuburb = normalizeText(tags["addr:suburb"] || "");
  const tagCountry = String(tags["addr:country"] || "IT").toUpperCase();

  if (tagCountry && tagCountry !== "IT") {
    return false;
  }

  // Se OSM indica esplicitamente un'altra citta' diversa da quella richiesta, scarta
  if (tagCity && !tagCity.includes(cityKey) && !cityKey.includes(tagCity)) {
    // Eccezione: frazioni/municipi dentro la citta' richiesta
    const combined = `${tagCity} ${tagSuburb}`;
    if (!combined.includes(cityKey)) {
      return false;
    }
  }

  // Se conosciamo i prefissi CAP per la citta' e c'e' un CAP valido, verifica coerenza
  const allowedPrefixes = CITY_CAP_PREFIXES[cityKey];
  if (allowedPrefixes && cap !== "99999") {
    const okCap = allowedPrefixes.some((pfx) => cap.startsWith(pfx));
    if (!okCap) {
      return false;
    }
  }

  return true;
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

async function fetchJsonSafe(url, options = {}, timeoutMs = 15000) {
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
          "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/OSM-Clean"
        },
        body: "data=" + encodeURIComponent(overpassQuery)
      },
      15000
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
    if (!isMatchingCityAndCap(citta, tags, cap)) {
      continue;
    }

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

const ROMA_SECTORS = [
  "41.9028,12.4964", // Centro / Repubblica / Monti
  "41.9065,12.4675", // Prati / Vaticano
  "41.9245,12.5135", // Salario / Nomentano / Trieste
  "41.8895,12.5125", // San Giovanni / Esquilino
  "41.8820,12.4730", // Trastevere / Testaccio
  "41.8555,12.4955", // Garbatella / Ostiense
  "41.8680,12.5480", // Tuscolana / Cinecitta'
  "41.8320,12.4680"  // EUR
];

async function searchOpenStreetMap(citta, zona = "", limit = 200) {
  const cityEsc = citta.replace(/"/g, '\\"');
  const isRoma = normalizeText(citta) === "roma";
  const zoneVariants = buildZoneVariants(zona);
  const zoneRegex = zoneVariants.map((z) => z.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const outCap = Math.min(Math.max(limit * 2, 300), 1200);

  if (isRoma) {
    const queries = zona
      ? [
          `
[out:json][timeout:20];
(
  node["amenity"="restaurant"]["name"~"${zoneRegex}",i](41.78,12.38,42.02,12.62);
  way["amenity"="restaurant"]["name"~"${zoneRegex}",i](41.78,12.38,42.02,12.62);
  node["amenity"="restaurant"]["addr:street"~"${zoneRegex}",i](41.78,12.38,42.02,12.62);
  node["amenity"="restaurant"]["addr:suburb"~"${zoneRegex}",i](41.78,12.38,42.02,12.62);
  node["cuisine"~"pizza",i]["name"~"${zoneRegex}",i](41.78,12.38,42.02,12.62);
);
out center tags ${outCap};
`.trim()
        ]
      : ROMA_SECTORS.map(
          (pt) => `
[out:json][timeout:18];
(
  node["amenity"="restaurant"]["name"](around:3000,${pt});
  way["amenity"="restaurant"]["name"](around:3000,${pt});
  node["cuisine"~"pizza",i]["name"](around:3000,${pt});
);
out center tags ${outCap};
`.trim()
        );

    const lists = await Promise.all(
      queries.map(async (q) => {
        const els = await runOverpassQuery(q);
        return mapOverpassElements(els, citta, zona);
      })
    );
    return lists.flat();
  }

  // Per qualsiasi altro comune italiano (Parma, Cerveteri, Ladispoli, Milano, ecc.)
  const q = `
[out:json][timeout:20];
area["name"~"^${cityEsc}$",i]["admin_level"~"6|7|8"]->.a;
(
  node["amenity"="restaurant"]["name"](area.a);
  way["amenity"="restaurant"]["name"](area.a);
  node["cuisine"~"pizza",i]["name"](area.a);
  way["cuisine"~"pizza",i]["name"](area.a);
);
out center tags ${outCap};
`.trim();

  const els = await runOverpassQuery(q);
  return mapOverpassElements(els, citta, zona);
}

function mergeSortByCapAndDeduplicate(items = [], limit = 200) {
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
    service: "vocalis-estrattore-osm-clean",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/restaurants", async (req, res) => {
  try {
    const cittaRaw = String(req.query.citta || "").trim();
    const zona = String(req.query.zona || "").trim();
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit || "200", 10) || 200));

    if (!cittaRaw) {
      return res.status(400).json({ error: "Parametro 'citta' obbligatorio." });
    }

    const citta = cittaRaw.charAt(0).toUpperCase() + cittaRaw.slice(1);
    const rawItems = await searchOpenStreetMap(citta, zona, limit);
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
  console.log(`Vocalis Lead Extractor (OSM Clean) in ascolto sulla porta ${PORT}`);
});
