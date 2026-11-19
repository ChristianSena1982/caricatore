const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));
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
  return cleaned;
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

async function fetchTextSafe(url, options = {}, timeoutMs = 7000) {
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

async function fetchJsonSafe(url, options = {}, timeoutMs = 12000) {
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
          "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/15.0"
        },
        body: "data=" + encodeURIComponent(overpassQuery)
      },
      13000
    );

    const elements = data && Array.isArray(data.elements) ? data.elements : [];
    if (elements.length > 0) return elements;
  }
  return [];
}

async function searchOverpassAllPlaces(citta, zona = "", limit = 200) {
  const cityEsc = citta.replace(/"/g, '\\"');
  const zoneVariants = buildZoneVariants(zona);
  const zoneRegex = zoneVariants.map((z) => z.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const outCap = Math.min(Math.max(limit * 3, 250), 1200);

  const queries = [];

  if (zona) {
    queries.push(`
[out:json][timeout:20];
area["name"~"^${cityEsc}$",i]["admin_level"~"6|7|8"]->.a;
(
  nwr["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream|bistro"]["name"~"${zoneRegex}",i](area.a);
  nwr["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream|bistro"]["addr:street"~"${zoneRegex}",i](area.a);
  nwr["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream|bistro"]["addr:suburb"~"${zoneRegex}",i](area.a);
  nwr["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream|bistro"]["addr:neighbourhood"~"${zoneRegex}",i](area.a);
);
out center tags ${outCap};
`.trim());
  }

  // Query principale per tutta la citta' (nodi + edifici/aree)
  queries.push(`
[out:json][timeout:20];
area["name"~"^${cityEsc}$",i]["admin_level"~"6|7|8"]->.a;
(
  node["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream|bistro"]["name"](area.a);
  way["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream|bistro"]["name"](area.a);
);
out center tags ${outCap};
`.trim());

  // Se e' Roma, aggiunge anche una query ampia sull'area metropolitana di Roma per massimizzare il volume
  if (normalizeText(citta) === "roma") {
    queries.push(`
[out:json][timeout:20];
(
  node["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream"]["name"](41.70,12.25,42.08,12.75);
  way["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream"]["name"](41.70,12.25,42.08,12.75);
);
out center tags ${outCap};
`.trim());
  }

  const results = await Promise.all(
    queries.map(async (q) => {
      const els = await runOverpassQuery(q);
      return mapOverpassElements(els, citta, zona);
    })
  );

  return results.flat();
}

async function searchPhotonAll(citta, zona = "") {
  const queries = zona
    ? [
        `ristorante ${zona} ${citta}`,
        `pizzeria ${zona} ${citta}`,
        `trattoria ${zona} ${citta}`,
        `osteria ${zona} ${citta}`,
        `bar ${zona} ${citta}`,
        `pub ${zona} ${citta}`,
        `ristorante ${citta}`,
        `pizzeria ${citta}`,
        `trattoria ${citta}`
      ]
    : [
        `ristorante ${citta}`,
        `pizzeria ${citta}`,
        `trattoria ${citta}`,
        `osteria ${citta}`,
        `bar ${citta}`,
        `pub ${citta}`,
        `bistrot ${citta}`,
        `gelateria ${citta}`,
        `ristoranti ${citta}`,
        `pizzerie ${citta}`
      ];

  const lists = await Promise.all(
    queries.map(async (q) => {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=50`;
      const data = await fetchJsonSafe(url, {}, 6000);
      const features = data && Array.isArray(data.features) ? data.features : [];
      const out = [];

      for (const f of features) {
        const p = f.properties || {};
        const name = String(p.name || "").trim();
        if (!name) continue;

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
    })
  );

  return lists.flat();
}

async function searchNominatimAll(citta, zona = "") {
  const queries = zona
    ? [
        `restaurant ${zona} ${citta}`,
        `pizzeria ${zona} ${citta}`,
        `trattoria ${zona} ${citta}`,
        `bar ${zona} ${citta}`,
        `restaurant ${citta}`,
        `pizzeria ${citta}`
      ]
    : [
        `restaurant ${citta}`,
        `pizzeria ${citta}`,
        `trattoria ${citta}`,
        `osteria ${citta}`,
        `bar ${citta}`,
        `pub ${citta}`
      ];

  const lists = await Promise.all(
    queries.map(async (q) => {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&extratags=1&limit=50`;
      const data = await fetchJsonSafe(
        url,
        { headers: { "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/15.0" } },
        7000
      );
      if (!Array.isArray(data)) return [];
      const out = [];

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
    })
  );

  return lists.flat();
}

function mergeAndDeduplicate(pools = [], zona = "", limit = 200) {
  const byKey = new Map();
  const zLow = normalizeText(zona);

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

  const all = Array.from(byKey.values());
  if (zLow) {
    all.sort((a, b) => {
      const matchA = `${a.zona} ${a.info} ${a.nome}`.toLowerCase().includes(zLow) ? 1 : 0;
      const matchB = `${b.zona} ${b.info} ${b.nome}`.toLowerCase().includes(zLow) ? 1 : 0;
      return matchB - matchA;
    });
  }

  return all.slice(0, limit);
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "vocalis-estrattore-ristoranti-v15",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/restaurants", async (req, res) => {
  try {
    const cittaRaw = String(req.query.citta || "").trim();
    const zona = String(req.query.zona || "").trim();
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || "200", 10) || 200));

    if (!cittaRaw) {
      return res.status(400).json({ error: "Parametro 'citta' obbligatorio." });
    }

    const citta = cittaRaw.charAt(0).toUpperCase() + cittaRaw.slice(1);

    const [overpassPool, photonPool, nominatimPool] = await Promise.all([
      searchOverpassAllPlaces(citta, zona, limit),
      searchPhotonAll(citta, zona),
      searchNominatimAll(citta, zona)
    ]);

    const items = mergeAndDeduplicate([overpassPool, photonPool, nominatimPool], zona, limit);

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
  console.log(`Vocalis Lead Extractor v15 in ascolto sulla porta ${PORT}`);
});
