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

async function fetchTextSafe(url, options = {}, timeoutMs = 4500) {
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

async function fetchJsonSafe(url, options = {}, timeoutMs = 8500) {
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

function extractContactsFromHtml(html, item) {
  if (!html) return;

  if (!item.email) {
    const mailMatch = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
    if (mailMatch && mailMatch[1]) {
      item.email = mailMatch[1].trim().toLowerCase();
    } else {
      const candidates = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.(?:it|com|eu|org|net)/gi) || [];
      const valid = candidates.find(
        (m) => !/example\.|sentry\.|wixpress\.|noreply\.|test@|wordpress\.|joomla\./i.test(m)
      );
      if (valid) item.email = valid.trim().toLowerCase();
    }
  }

  if (!item.whatsapp) {
    const waMatch = html.match(/(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?\d{8,15})/i);
    if (waMatch && waMatch[1]) {
      const formattedWa = formatItalianMobile(waMatch[1]);
      if (formattedWa) item.whatsapp = formattedWa;
    }
  }

  if (!item.telefono) {
    const telHrefMatch = html.match(/href=["']tel:([+0-9\s().-]{7,22})["']/i);
    if (telHrefMatch && telHrefMatch[1]) {
      const formatted = formatItalianPhone(telHrefMatch[1]);
      if (formatted) {
        item.telefono = formatted;
        if (!item.whatsapp && isItalianMobile(formatted)) {
          item.whatsapp = formatItalianMobile(formatted);
        }
      }
    }
  }

  if (!item.telefono) {
    const itPhoneMatch = html.match(/(?:\+39\s*)?(?:0\d{1,3}[\s.-]?\d{5,8}|3\d{2}[\s.-]?\d{6,7})/);
    if (itPhoneMatch && itPhoneMatch[0]) {
      const formatted = formatItalianPhone(itPhoneMatch[0]);
      if (formatted) {
        item.telefono = formatted;
        if (!item.whatsapp && isItalianMobile(formatted)) {
          item.whatsapp = formatItalianMobile(formatted);
        }
      }
    }
  }
}

function parseSearchResultsHtml(html, item) {
  if (!html) return;

  if (!item.sito) {
    const hrefMatches = html.match(/href="(https?:\/\/[^"]+)"/gi) || [];
    for (const rawHref of hrefMatches) {
      const cleanHref = rawHref.replace(/^href="/i, "").replace(/"$/, "");
      let decoded = cleanHref;
      try {
        const parsed = new URL(cleanHref);
        if (parsed.hostname.includes("duckduckgo.com") && parsed.searchParams.get("uddg")) {
          decoded = decodeURIComponent(parsed.searchParams.get("uddg"));
        }
      } catch {
        // usa cleanHref
      }
      if (!isJunkDomain(decoded)) {
        item.sito = normalizeUrl(decoded);
        break;
      }
    }
  }

  extractContactsFromHtml(html, item);
}

async function enrichFromWebsite(item) {
  if (!item.sito || (item.email && item.telefono && item.whatsapp)) return item;

  const html = await fetchTextSafe(item.sito, {}, 3000);
  if (!html) return item;

  extractContactsFromHtml(html, item);

  const subPaths = ["/contatti", "/contact", "/info"];
  for (const sp of subPaths) {
    if (item.email && item.telefono && item.whatsapp) break;
    try {
      const subUrl = new URL(sp, item.sito).toString();
      const subHtml = await fetchTextSafe(subUrl, {}, 2200);
      if (subHtml) extractContactsFromHtml(subHtml, item);
    } catch {
      // ignora
    }
  }

  return item;
}

async function enrichFromWebSearch(item) {
  if (item.sito && item.telefono) return item;

  const q = `"${item.nome}" ${item.citta} telefono`;
  const ddgHtml = await fetchTextSafe(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    {},
    3000
  );
  parseSearchResultsHtml(ddgHtml, item);
  return item;
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

async function searchOverpassUnrestricted(citta, zona = "", limit = 100) {
  const cityEsc = citta.replace(/"/g, '\\"');
  const zoneVariants = buildZoneVariants(zona);
  const zoneRegex = zoneVariants.map((z) => z.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  const overpassQuery = zona
    ? `
[out:json][timeout:20];
area["name"~"^${cityEsc}$",i]["admin_level"~"6|7|8"]->.cityArea;
(
  way["name"~"${zoneRegex}",i](area.cityArea)->.zoneWays;
  nwr(around.zoneWays:220)["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream"]["name"](area.cityArea);
  nwr["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream"]["name"]["addr:street"~"${zoneRegex}",i](area.cityArea);
  nwr["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream"]["name"]["addr:suburb"~"${zoneRegex}",i](area.cityArea);
  nwr["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream"]["name"~"${zoneRegex}",i](area.cityArea);
);
out center tags ${Math.min(limit * 4, 400)};
`.trim()
    : `
[out:json][timeout:20];
(
  area["name"~"^${cityEsc}$",i]["admin_level"~"6|7|8"]->.searchArea;
  (
    node["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream"]["name"](area.searchArea);
    way["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream"]["name"](area.searchArea);
  );
);
out center tags ${Math.min(limit * 4, 400)};
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
          "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/11.0"
        },
        body: "data=" + encodeURIComponent(overpassQuery)
      },
      12000
    );

    const elements = data && Array.isArray(data.elements) ? data.elements : [];
    if (elements.length > 0) {
      return mapOverpassElements(elements, citta, zona);
    }
  }

  return [];
}

async function searchPhotonUnrestricted(citta, zona = "") {
  const queries = zona
    ? [
        `ristorante ${zona} ${citta}`,
        `pizzeria ${zona} ${citta}`,
        `trattoria ${zona} ${citta}`,
        `osteria ${zona} ${citta}`,
        `bar ${zona} ${citta}`,
        `bistrot ${zona} ${citta}`,
        `pub ${zona} ${citta}`,
        `via ${zona} ${citta} ristorante`
      ]
    : [
        `ristorante ${citta}`,
        `pizzeria ${citta}`,
        `trattoria ${citta}`,
        `osteria ${citta}`,
        `bar ${citta}`,
        `pub ${citta}`,
        `ristoranti ${citta}`,
        `pizzerie ${citta}`
      ];

  const items = [];
  const zoneVariants = buildZoneVariants(zona);

  for (const q of queries) {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=50`;
    const data = await fetchJsonSafe(url, {}, 5000);
    const features = data && Array.isArray(data.features) ? data.features : [];

    for (const f of features) {
      const p = f.properties || {};
      const name = String(p.name || "").trim();
      if (!name) continue;

      if (zoneVariants.length > 0) {
        const hay = normalizeText(
          `${name} ${p.street || ""} ${p.district || ""} ${p.locality || ""} ${p.suburb || ""} ${p.city || ""}`
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

      items.push({
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
    if (items.length >= 250) break;
  }

  return items;
}

async function searchNominatimUnrestricted(citta, zona = "") {
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
        `osteria ${citta}, Italia`
      ];

  const items = [];
  const zoneVariants = buildZoneVariants(zona);

  for (const q of queries) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&extratags=1&limit=50`;
    const data = await fetchJsonSafe(
      url,
      { headers: { "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/11.0" } },
      6000
    );
    if (!Array.isArray(data)) continue;

    for (const row of data) {
      const name = String(row.name || "").split(",")[0].trim();
      if (!name) continue;
      const addr = row.address || {};
      const extra = row.extratags || {};

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

      items.push({
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
    if (items.length >= 160) break;
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
        if ((!existing.info || existing.info.length < 20) && item.info && item.info.length > existing.info.length) {
          existing.info = item.info;
        }
      }
    }
  }

  const all = Array.from(byKey.values());
  all.sort((a, b) => {
    const scoreA = (a.telefono ? 4 : 0) + (a.whatsapp ? 3 : 0) + (a.sito ? 2 : 0) + (a.email ? 2 : 0);
    const scoreB = (b.telefono ? 4 : 0) + (b.whatsapp ? 3 : 0) + (b.sito ? 2 : 0) + (b.email ? 2 : 0);
    return scoreB - scoreA;
  });

  return all.slice(0, limit);
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "vocalis-estrattore-ristoranti-v11",
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
      searchOverpassUnrestricted(citta, zona, limit),
      searchPhotonUnrestricted(citta, zona),
      searchNominatimUnrestricted(citta, zona)
    ]);

    let items = mergeAndDeduplicate([overpassPool, photonPool, nominatimPool], limit);

    const needWebLookup = items.filter((it) => !it.sito || !it.telefono).slice(0, 25);
    await Promise.all(needWebLookup.map((it) => enrichFromWebSearch(it)));

    const withSites = items.filter((it) => it.sito && (!it.email || !it.telefono || !it.whatsapp)).slice(0, 30);
    await Promise.all(withSites.map((it) => enrichFromWebsite(it)));

    items = mergeAndDeduplicate([items], limit);

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
  console.log(`Vocalis Lead Extractor v11 in ascolto sulla porta ${PORT}`);
});
