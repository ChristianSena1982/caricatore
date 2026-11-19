const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "15mb" }));
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

function isJunkOrForeignDomain(urlStr) {
  const low = String(urlStr || "").toLowerCase();
  if (!low) return true;
  const blocked = [
    "tripadvisor.", "yelp.", "thefork.", "justeat.", "deliveroo.",
    "ubereats.", "glovoapp.", "openstreetmap.org", "wikipedia.org",
    "wikidata.org", "duckduckgo.com", "bing.com", "microsoft.com",
    "google.", "facebook.com", "instagram.com", "tiktok.com", "youtube.com"
  ];
  if (blocked.some((b) => low.includes(b))) return true;

  try {
    const hostname = new URL(normalizeUrl(low)).hostname;
    if (/\.(es|de|ro|fr|uk|ch|at|nl|be|pt|pl|gr|us|ca|ru|br|ar|mx)$/i.test(hostname)) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

function isInsideItaly(lat, lon, countryCode = "", addressText = "", phone = "", website = "") {
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
  const phoneClean = String(phone || "").replace(/[\s\-().]/g, "");
  if (phoneClean.startsWith("+") && !phoneClean.startsWith("+39") && !phoneClean.startsWith("0039")) {
    return false;
  }
  if (website && isJunkOrForeignDomain(website)) {
    return false;
  }
  const lowAddr = normalizeText(addressText);
  const foreignTokens = [
    "carrer ", "calle ", "avenida ", "barcelona", "madrid", "spain", "espana",
    "spandau", "berlin", "munich", "munchen", "hamburg", "germany", "deutschland",
    "bucharest", "bucuresti", "drumul ", "romania",
    "paris", "lyon", "marseille", "france",
    "london", "united kingdom", "zurich", "geneva", "switzerland", "schweiz",
    "vienna", "wien", "austria", "canada", "united states", "finland", "suomi"
  ];
  return !foreignTokens.some((ft) => lowAddr.includes(ft));
}

// Accetta solo ristoranti e pizzerie (escludendo bar, pub, gelaterie, fast food generici)
function isRestaurantOrPizzeria(name = "", amenity = "", cuisine = "") {
  const aLow = normalizeText(amenity);
  const cLow = normalizeText(cuisine);
  const nLow = normalizeText(name);

  if (["bar", "pub", "cafe", "ice_cream", "biergarten"].includes(aLow)) {
    return false;
  }
  if (aLow === "restaurant") return true;
  if (cLow.includes("pizza") || nLow.includes("pizzeria") || nLow.includes("pizza") || nLow.includes("ristorante") || nLow.includes("trattoria") || nLow.includes("osteria")) {
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
  const website = isJunkOrForeignDomain(candidateSite) ? "" : candidateSite;

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

async function fetchTextSafe(url, options = {}, timeoutMs = 8000) {
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

async function fetchJsonSafe(url, options = {}, timeoutMs = 15000) {
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

    if (!isRestaurantOrPizzeria(name, tags.amenity || "", tags.cuisine || "")) {
      continue;
    }

    const lat = el.lat || (el.center && el.center.lat);
    const lon = el.lon || (el.center && el.center.lon);
    const contacts = extractContacts(tags);
    const addrText = `${tags["addr:city"] || ""} ${tags["addr:street"] || ""} ${tags["addr:suburb"] || ""} ${tags["addr:country"] || ""}`;

    if (!isInsideItaly(lat, lon, tags["addr:country"] || "IT", addrText, contacts.phone, contacts.website)) {
      continue;
    }

    const cap = extractCap(tags["addr:postcode"] || "", "");
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
          "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/18.0"
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

const ROMA_SECTORS = [
  "41.9028,12.4964",
  "41.9065,12.4675",
  "41.9245,12.5135",
  "41.8895,12.5125",
  "41.8820,12.4730",
  "41.8555,12.4955",
  "41.8680,12.5480",
  "41.9120,12.5620",
  "41.9480,12.4750",
  "41.8320,12.4680"
];

async function searchOverpassRestaurantsAndPizzerias(citta, zona = "", limit = 2000) {
  const cityEsc = citta.replace(/"/g, '\\"');
  const isRoma = normalizeText(citta) === "roma";
  const zoneVariants = buildZoneVariants(zona);
  const zoneRegex = zoneVariants.map((z) => z.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const chunkCap = Math.min(Math.max(limit, 500), 2500);

  if (isRoma) {
    const queries = zona
      ? [
          `
[out:json][timeout:25];
(
  nwr["amenity"="restaurant"]["name"~"${zoneRegex}",i](41.68,12.22,42.10,12.80);
  nwr["amenity"="restaurant"]["addr:street"~"${zoneRegex}",i](41.68,12.22,42.10,12.80);
  nwr["amenity"="restaurant"]["addr:suburb"~"${zoneRegex}",i](41.68,12.22,42.10,12.80);
  nwr["cuisine"~"pizza",i]["name"~"${zoneRegex}",i](41.68,12.22,42.10,12.80);
  nwr["name"~"pizzeria|pizza",i]["name"~"${zoneRegex}",i](41.68,12.22,42.10,12.80);
);
out center tags ${chunkCap};
`.trim()
        ]
      : ROMA_SECTORS.map(
          (pt) => `
[out:json][timeout:20];
(
  node["amenity"="restaurant"]["name"](around:3500,${pt});
  way["amenity"="restaurant"]["name"](around:3500,${pt});
  node["cuisine"~"pizza",i]["name"](around:3500,${pt});
  way["cuisine"~"pizza",i]["name"](around:3500,${pt});
);
out center tags ${chunkCap};
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

  const q = `
[out:json][timeout:25];
area["name"~"^${cityEsc}$",i]["admin_level"~"6|7|8"]->.a;
(
  node["amenity"="restaurant"]["name"](area.a);
  way["amenity"="restaurant"]["name"](area.a);
  node["cuisine"~"pizza",i]["name"](area.a);
  way["cuisine"~"pizza",i]["name"](area.a);
);
out center tags ${chunkCap};
`.trim();

  const els = await runOverpassQuery(q);
  return mapOverpassElements(els, citta, zona);
}

async function searchPhotonRestaurantsAndPizzerias(citta, zona = "") {
  const queries = zona
    ? [
        `ristorante ${zona} ${citta} italia`,
        `pizzeria ${zona} ${citta} italia`,
        `trattoria ${zona} ${citta} italia`,
        `osteria ${zona} ${citta} italia`
      ]
    : [
        `ristorante ${citta} italia`,
        `pizzeria ${citta} italia`,
        `trattoria ${citta} italia`,
        `osteria ${citta} italia`,
        `ristoranti ${citta} italia`,
        `pizzerie ${citta} italia`
      ];

  const zoneVariants = buildZoneVariants(zona);

  const lists = await Promise.all(
    queries.map(async (q) => {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=50`;
      const data = await fetchJsonSafe(url, {}, 6500);
      const features = data && Array.isArray(data.features) ? data.features : [];
      const out = [];

      for (const f of features) {
        const p = f.properties || {};
        const coords = (f.geometry && f.geometry.coordinates) || [];
        const lon = coords[0];
        const lat = coords[1];
        const name = String(p.name || "").trim();
        if (!name) continue;

        if (!isRestaurantOrPizzeria(name, p.osm_value || p.type || "restaurant", p.cuisine || "")) {
          continue;
        }

        const contacts = extractContacts(p);
        const addrString = `${p.city || ""} ${p.street || ""} ${p.district || ""} ${p.country || ""}`;
        if (!isInsideItaly(lat, lon, p.countrycode || "IT", addrString, contacts.phone, contacts.website)) {
          continue;
        }

        if (zoneVariants.length > 0) {
          const hay = normalizeText(
            `${name} ${p.street || ""} ${p.district || ""} ${p.locality || ""} ${p.suburb || ""}`
          );
          if (!zoneVariants.some((zv) => hay.includes(zv))) continue;
        }

        const info = buildInfoLine({
          street: p.street || "",
          housenumber: p.housenumber || "",
          postcode: p.postcode || "",
          cuisine: p.cuisine || "",
          kind: p.osm_value || p.type || "restaurant"
        });

        out.push({
          nome: name,
          info: info || "Ristorante / Pizzeria",
          citta,
          zona: zona || p.district || p.locality || p.suburb || p.street || "Centro",
          cap: extractCap(p.postcode || "", info),
          sito: contacts.website,
          telefono: contacts.phone,
          whatsapp: contacts.whatsapp,
          email: contacts.email
        });
      }

      return out;
    })
  );

  return lists.flat();
}

async function searchNominatimRestaurantsAndPizzerias(citta, zona = "") {
  const queries = zona
    ? [
        `restaurant ${zona} ${citta}, Italia`,
        `pizzeria ${zona} ${citta}, Italia`,
        `trattoria ${zona} ${citta}, Italia`
      ]
    : [
        `restaurant ${citta}, Italia`,
        `pizzeria ${citta}, Italia`,
        `trattoria ${citta}, Italia`,
        `osteria ${citta}, Italia`
      ];

  const zoneVariants = buildZoneVariants(zona);

  const lists = await Promise.all(
    queries.map(async (q) => {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&extratags=1&countrycodes=it&limit=50`;
      const data = await fetchJsonSafe(
        url,
        { headers: { "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/18.0" } },
        7500
      );
      if (!Array.isArray(data)) return [];
      const out = [];

      for (const row of data) {
        const name = String(row.name || "").split(",")[0].trim();
        if (!name) continue;
        const addr = row.address || {};
        const extra = row.extratags || {};

        if (!isRestaurantOrPizzeria(name, row.type || "restaurant", extra.cuisine || "")) {
          continue;
        }

        const contacts = extractContacts(extra);
        if (!isInsideItaly(row.lat, row.lon, addr.country_code || "it", row.display_name || "", contacts.phone, contacts.website)) {
          continue;
        }

        if (zoneVariants.length > 0) {
          const hay = normalizeText(
            `${name} ${row.display_name || ""} ${addr.road || ""} ${addr.suburb || ""} ${addr.neighbourhood || ""}`
          );
          if (!zoneVariants.some((zv) => hay.includes(zv))) continue;
        }

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
          info: info || "Ristorante / Pizzeria",
          citta,
          zona: zona || addr.suburb || addr.neighbourhood || addr.city_district || addr.road || "Centro",
          cap: extractCap(addr.postcode || "", info),
          sito: contacts.website,
          telefono: contacts.phone,
          whatsapp: contacts.whatsapp,
          email: contacts.email
        });
      }

      return out;
    })
  );

  return lists.flat();
}

function mergeSortByCapAndDeduplicate(pools = [], limit = 2000) {
  const byKey = new Map();

  for (const pool of pools) {
    for (const item of pool) {
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
    service: "vocalis-estrattore-ristoranti-v18",
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

    const [overpassPool, photonPool, nominatimPool] = await Promise.all([
      searchOverpassRestaurantsAndPizzerias(citta, zona, limit),
      searchPhotonRestaurantsAndPizzerias(citta, zona),
      searchNominatimRestaurantsAndPizzerias(citta, zona)
    ]);

    const items = mergeSortByCapAndDeduplicate([overpassPool, photonPool, nominatimPool], limit);

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
  console.log(`Vocalis Lead Extractor v18 in ascolto sulla porta ${PORT}`);
});
