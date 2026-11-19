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

async function fetchTextSafe(url, options = {}, timeoutMs = 5500) {
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

async function guessWebsiteDomain(item) {
  if (item.sito) return item;
  const slug = normalizeKey(item.nome)
    .replace(/^(ristorante|trattoria|pizzeria|osteria|bar|caffe|pub|gelateria)/, "");
  if (!slug || slug.length < 4 || slug.length > 28) return item;

  const candidates = [`https://www.${slug}.it`, `https://www.${slug}.com`];
  for (const url of candidates) {
    const html = await fetchTextSafe(url, {}, 3000);
    if (html && html.length > 400 && !/dominio in vendita|domain for sale|parked/i.test(html)) {
      item.sito = url;
      extractContactsFromHtml(html, item);
      return item;
    }
  }
  return item;
}

async function enrichFromWebsite(item) {
  if (!item.sito || (item.email && item.telefono && item.whatsapp)) return item;

  const html = await fetchTextSafe(item.sito, {}, 4500);
  if (!html) return item;

  extractContactsFromHtml(html, item);

  const subPaths = ["/contatti", "/contact", "/contatti.html", "/chi-siamo", "/info"];
  const foundLinks = [];
  const linkMatches = html.match(/href=["']([^"']*(?:contatt|contact|info|dove-siamo|chi-siamo)[^"']*)["']/gi) || [];
  for (const m of linkMatches) {
    const rawPath = m.replace(/^href=["']/i, "").replace(/["']$/, "");
    try {
      foundLinks.push(new URL(rawPath, item.sito).toString());
    } catch {
      // ignora
    }
  }
  for (const sp of subPaths) {
    try {
      foundLinks.push(new URL(sp, item.sito).toString());
    } catch {
      // ignora
    }
  }

  const uniqueLinks = Array.from(new Set(foundLinks)).slice(0, 3);
  for (const linkUrl of uniqueLinks) {
    if (item.email && item.telefono && item.whatsapp) break;
    const subHtml = await fetchTextSafe(linkUrl, {}, 3500);
    if (subHtml) extractContactsFromHtml(subHtml, item);
  }

  return item;
}

async function enrichFromWebSearch(item) {
  if (item.sito && item.telefono) return item;

  const q = `"${item.nome}" ${item.citta} telefono`;
  const [ddgHtml, bingHtml] = await Promise.all([
    fetchTextSafe(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {}, 5000),
    fetchTextSafe(`https://www.bing.com/search?q=${encodeURIComponent(q)}`, {}, 5000)
  ]);

  parseSearchResultsHtml(ddgHtml, item);
  parseSearchResultsHtml(bingHtml, item);

  if (!item.sito) {
    await guessWebsiteDomain(item);
  }

  return item;
}

function mapOverpassElements(elements, citta, zona) {
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
  return items;
}

// 1) Query Overpass mirata SOLO sui locali che hanno gia' telefono o sito web compilati!
async function searchOverpassWithContacts(citta, zona = "", limit = 100) {
  const cityEsc = citta.replace(/"/g, '\\"');
  const overpassQuery = `
[out:json][timeout:25];
(
  area["name"~"^${cityEsc}$",i]["admin_level"~"6|7|8"]->.searchArea;
  (
    nwr["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream"]["name"]["phone"](area.searchArea);
    nwr["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream"]["name"]["contact:phone"](area.searchArea);
    nwr["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream"]["name"]["website"](area.searchArea);
    nwr["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream"]["name"]["contact:website"](area.searchArea);
  );
);
out center tags ${Math.min(limit * 3, 400)};
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
          "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/7.0"
        },
        body: "data=" + encodeURIComponent(overpassQuery)
      },
      15000
    );

    const elements = data && Array.isArray(data.elements) ? data.elements : [];
    if (elements.length > 0) {
      return mapOverpassElements(elements, citta, zona);
    }
  }

  return [];
}

// 2) Query Overpass generale di supporto per completare fino a 100 locali
async function searchOverpassGeneral(citta, zona = "", limit = 100) {
  const cityEsc = citta.replace(/"/g, '\\"');
  const overpassQuery = `
[out:json][timeout:25];
(
  area["name"~"^${cityEsc}$",i]["admin_level"~"6|7|8"]->.searchArea;
  (
    nwr["amenity"~"restaurant|fast_food|cafe|bar|pub|ice_cream"]["name"](area.searchArea);
  );
);
out center tags ${Math.min(limit * 2, 250)};
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
          "User-Agent": "Artsoftware2022-Vocalis-LeadExtractor/7.0"
        },
        body: "data=" + encodeURIComponent(overpassQuery)
      },
      15000
    );

    const elements = data && Array.isArray(data.elements) ? data.elements : [];
    if (elements.length > 0) {
      return mapOverpassElements(elements, citta, zona);
    }
  }

  return [];
}

async function searchPhoton(citta, zona = "") {
  const queries = zona
    ? [
        `ristorante ${zona} ${citta}`,
        `pizzeria ${zona} ${citta}`,
        `trattoria ${zona} ${citta}`
      ]
    : [
        `ristorante ${citta}`,
        `pizzeria ${citta}`,
        `trattoria ${citta}`,
        `osteria ${citta}`
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
    if (items.length >= 120) break;
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

  // Ordina mettendo prima i locali che hanno piu' contatti reali (telefono / whatsapp / sito / email)
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
    service: "vocalis-estrattore-ristoranti-v7-free",
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

    // Prima prende i locali con contatti gia' presenti, poi completa con gli altri
    const contactsFirstPool = await searchOverpassWithContacts(citta, zona, limit);

    let extraPools = [];
    if (contactsFirstPool.length < limit) {
      const [generalPool, photonPool] = await Promise.all([
        searchOverpassGeneral(citta, zona, limit),
        searchPhoton(citta, zona)
      ]);
      extraPools = [generalPool, photonPool];
    }

    let items = mergeAndDeduplicate([contactsFirstPool, ...extraPools], limit);

    // Arricchimento web per chi e' ancora senza sito o telefono
    const needWebLookup = items.filter((it) => !it.sito || !it.telefono).slice(0, 45);
    for (let i = 0; i < needWebLookup.length; i += 10) {
      const batch = needWebLookup.slice(i, i + 10);
      await Promise.all(batch.map((it) => enrichFromWebSearch(it)));
    }

    // Estrazione email/tel/whatsapp dai siti web trovati
    for (let i = 0; i < items.length; i += 10) {
      const batch = items.slice(i, i + 10);
      await Promise.all(batch.map((it) => enrichFromWebsite(it)));
    }

    // Riordina mettendo in cima quelli arricchiti con piu' dati
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
  console.log(`Vocalis Lead Extractor v7 (100% Free) in ascolto sulla porta ${PORT}`);
});
