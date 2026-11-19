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
    low.includes("duckduckgo.com") ||
    low.includes("google.")
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
      tags["contact:instagram"] ||
      tags["contact:facebook"] ||
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

async function fetchTextSafe(url, options = {}, timeoutMs = 6000) {
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

async function fetchJsonSafe(url, options = {}, timeoutMs = 9000) {
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
        (m) => !/example\.|sentry\.|wixpress\.|noreply\.|test@/i.test(m)
      );
      if (valid) item.email = valid.trim().toLowerCase();
    }
  }

  if (!item.whatsapp) {
    const waMatch = html.match(/(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?\d{8,15})/i);
    if (waMatch && waMatch[1]) {
      item.whatsapp = formatItalianMobile(waMatch[1]) || waMatch[1];
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

// Visita homepage e pagina contatti eventuale del ristorante per estrarre email, tel e whatsapp
async function enrichFromWebsite(item) {
  if (!item.sito || (item.email && item.telefono && item.whatsapp)) return item;
  if (/instagram\.com|facebook\.com/i.test(item.sito)) return item;

  const html = await fetchTextSafe(item.sito, {}, 4500);
  if (!html) return item;

  extractContactsFromHtml(html, item);

  if (!item.email || !item.telefono) {
    const contactLinkMatch = html.match(/href=["']([^"']*(?:contatt|contact|info|dove-siamo)[^"']*)["']/i);
    if (contactLinkMatch && contactLinkMatch[1]) {
      try {
        const contactUrl = new URL(contactLinkMatch[1], item.sito).toString();
        const contactHtml = await fetchTextSafe(contactUrl, {}, 4000);
        if (contactHtml) extractContactsFromHtml(contactHtml, item);
      } catch {
        // ignora URL relativi non validi
      }
    }
  }

  return item;
}

// Ricerca web pubblica per trovare sito, telefono o whatsapp quando mancano su OSM
async function enrichFromWebSearch(item) {
  if (item.sito && item.telefono) return item;

  const query = `${item.nome} ${item.citta} telefono sito`;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchTextSafe(url, {}, 5500);
  if (!html) return item;

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
  return item;
}

async function searchOverpass(citta, zona = "", limit = 100) {
  const cityEsc = citta.replace(/"/g, '\\"');
  const overpassQuery = `
[out:json][timeout:25];
(
  area["name"~"^${cityEsc}$",i]["admin_level"~"6|7|8"]->.searchArea;
  (
    node["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream"]["name"](area.searchArea);
    way["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream"]["name"](area.searchArea);
  );
);
out center tags ${Math.min(limit * 3, 300)};
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
          "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/4.0"
        },
        body: "data=" + encodeURIComponent(overpassQuery)
      },
      15000
    );

    const elements = data && Array.isArray(data.elements) ? data.elements : [];
    if (!elements.length) continue;

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
        "Centro";

      if (zona) {
        const zLow = zona.toLowerCase();
        const hayZone = `${detectedZone} ${tags["addr:street"] || ""} ${name}`.toLowerCase();
        if (!hayZone.includes(zLow)) continue;
      }

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
        zona: zona || detectedZone,
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
        `bar ${zona} ${citta}`
      ]
    : [
        `ristorante ${citta}`,
        `pizzeria ${citta}`,
        `trattoria ${citta}`,
        `osteria ${citta}`,
        `ristoranti ${citta}`,
        `bar ${citta}`
      ];

  const items = [];
  const wantedCity = citta.toLowerCase().trim();

  for (const q of queries) {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=50`;
    const data = await fetchJsonSafe(url, {}, 6500);
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
    if (items.length >= 160) break;
  }

  return items;
}

async function searchNominatim(citta, zona = "") {
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

  const items = [];
  for (const q of queries) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&extratags=1&limit=50`;
    const data = await fetchJsonSafe(
      url,
      { headers: { "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/4.0" } },
      7500
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
    if (items.length >= 100) break;
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
        if ((!existing.zona || existing.zona === "Centro") && item.zona && item.zona !== "Centro") {
          existing.zona = item.zona;
        }
      }
    }
  }

  return Array.from(byKey.values()).slice(0, limit);
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "vocalis-estrattore-ristoranti-v4", timestamp: new Date().toISOString() });
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
      searchOverpass(citta, zona, limit),
      searchPhoton(citta, zona),
      searchNominatim(citta, zona)
    ]);

    let items = mergeAndDeduplicate([overpassPool, photonPool, nominatimPool], limit);

    // 1. Ricerca web per i primi 35 locali privi di sito o telefono
    const needWebLookup = items.filter((it) => !it.sito || !it.telefono).slice(0, 35);
    for (let i = 0; i < needWebLookup.length; i += 7) {
      const batch = needWebLookup.slice(i, i + 7);
      await Promise.all(batch.map((it) => enrichFromWebSearch(it)));
    }

    // 2. Visita i siti ufficiali trovati per estrarre email, tel e whatsapp
    for (let i = 0; i < items.length; i += 8) {
      const batch = items.slice(i, i + 8);
      await Promise.all(batch.map((it) => enrichFromWebsite(it)));
    }

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
  console.log(`Vocalis Lead Extractor v4 in ascolto sulla porta ${PORT}`);
});
