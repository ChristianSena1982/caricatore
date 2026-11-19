const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter"
];

function norm(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function normKey(str) {
  return norm(str).replace(/[^a-z0-9]/g, "");
}

function extractCap(tags = {}, fallbackText = "") {
  const raw = String(tags["addr:postcode"] || fallbackText || "");
  const m = raw.match(/\b\d{5}\b/);
  return m ? m[0] : "99999";
}

function isRestaurantOrPizzeria(tags = {}) {
  const amenity = norm(tags.amenity);
  const cuisine = norm(tags.cuisine);
  const name = norm(tags.name);

  if (!name) return false;
  if (["bar", "pub", "cafe", "ice_cream", "biergarten"].includes(amenity)) {
    return false;
  }

  return (
    amenity === "restaurant" ||
    cuisine.includes("pizza") ||
    name.includes("pizzeria") ||
    name.includes("pizza") ||
    name.includes("ristorante") ||
    name.includes("trattoria") ||
    name.includes("osteria")
  );
}

function belongsToRequestedCity(citta, tags = {}) {
  const reqCity = norm(citta);
  const addrCity = norm(tags["addr:city"]);
  const addrSuburb = norm(tags["addr:suburb"]);
  const addrCountry = String(tags["addr:country"] || "IT").toUpperCase();

  if (addrCountry && addrCountry !== "IT") return false;
  if (addrCity) {
    return (
      addrCity === reqCity ||
      addrCity.includes(reqCity) ||
      reqCity.includes(addrCity) ||
      addrSuburb.includes(reqCity)
    );
  }
  return true;
}

function cleanUrl(raw) {
  const u = String(raw || "").trim();
  if (!u) return "";
  const full = /^https?:\/\//i.test(u) ? u : "https://" + u;
  const low = full.toLowerCase();
  const junk = [
    "tripadvisor.", "yelp.", "thefork.", "justeat.", "deliveroo.",
    "ubereats.", "glovoapp.", "facebook.com", "instagram.com",
    "tiktok.com", "wikipedia.org", "openstreetmap.org", "google."
  ];
  return junk.some((j) => low.includes(j)) ? "" : full;
}

function cleanPhone(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const compact = s.replace(/[\s\-().]/g, "");
  if (compact.startsWith("+") && !compact.startsWith("+39") && !compact.startsWith("0039")) {
    return "";
  }
  return s;
}

async function queryOverpass(ql) {
  for (const url of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 16000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": "VocalisLeadExtractor/1.0"
        },
        body: "data=" + encodeURIComponent(ql),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const json = await resp.json();
      if (Array.isArray(json.elements) && json.elements.length > 0) {
        return json.elements;
      }
    } catch {
      clearTimeout(timer);
    }
  }
  return [];
}

async function getCityBbox(citta) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const u = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      citta + ", Italia"
    )}&format=jsonv2&countrycodes=it&limit=1`;
    const resp = await fetch(u, {
      headers: { "User-Agent": "VocalisLeadExtractor/1.0" },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const arr = await resp.json();
    if (Array.isArray(arr) && arr[0] && Array.isArray(arr[0].boundingbox)) {
      const [south, north, west, east] = arr[0].boundingbox;
      return `${south},${west},${north},${east}`;
    }
  } catch {
    clearTimeout(timer);
  }
  return null;
}

app.get("/api/restaurants", async (req, res) => {
  try {
    const cittaRaw = String(req.query.citta || "").trim();
    const zona = String(req.query.zona || "").trim();
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || "200", 10) || 200));

    if (!cittaRaw) {
      return res.status(400).json({ error: "Inserisci una città italiana." });
    }

    const citta = cittaRaw.charAt(0).toUpperCase() + cittaRaw.slice(1);
    const cityEsc = citta.replace(/"/g, '\\"');
    const bbox = await getCityBbox(citta);

    let elements = [];
    if (bbox) {
      const qlBbox = `
[out:json][timeout:22];
(
  node["amenity"="restaurant"]["name"](${bbox});
  way["amenity"="restaurant"]["name"](${bbox});
  node["cuisine"~"pizza",i]["name"](${bbox});
  way["cuisine"~"pizza",i]["name"](${bbox});
);
out center tags 1500;
`.trim();
      elements = await queryOverpass(qlBbox);
    }

    if (elements.length === 0) {
      const qlArea = `
[out:json][timeout:22];
area["name"~"^${cityEsc}$",i]->.a;
(
  node["amenity"="restaurant"]["name"](area.a);
  way["amenity"="restaurant"]["name"](area.a);
  node["cuisine"~"pizza",i]["name"](area.a);
  way["cuisine"~"pizza",i]["name"](area.a);
);
out center tags 1500;
`.trim();
      elements = await queryOverpass(qlArea);
    }

    const zonaNorm = norm(zona);
    const dedup = new Map();

    for (const el of elements) {
      const tags = el.tags || {};
      if (!isRestaurantOrPizzeria(tags)) continue;
      if (!belongsToRequestedCity(citta, tags)) continue;

      const nome = String(tags.name || "").trim();
      const key = normKey(nome);
      if (!key) continue;

      const street = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ").trim();
      const cap = extractCap(tags, street);
      const cucina = tags.cuisine ? `Cucina: ${String(tags.cuisine).replace(/_/g, " ")}` : "";
      const capLabel = cap !== "99999" ? `CAP ${cap}` : "";
      const info = [street, capLabel, cucina].filter(Boolean).join(" • ") || "Ristorante / Pizzeria";

      const detectedZone =
        tags["addr:suburb"] ||
        tags["addr:neighbourhood"] ||
        tags["addr:city_district"] ||
        tags["addr:street"] ||
        "Centro";

      if (zonaNorm) {
        const hay = norm(`${nome} ${info} ${detectedZone}`);
        if (!hay.includes(zonaNorm)) continue;
      }

      const telefono = cleanPhone(tags.phone || tags["contact:phone"] || "");
      const whatsapp = cleanPhone(tags["contact:whatsapp"] || tags.whatsapp || "");
      const sito = cleanUrl(tags.website || tags["contact:website"] || "");
      const email = String(tags.email || tags["contact:email"] || "").trim();

      if (!dedup.has(key)) {
        dedup.set(key, {
          nome,
          info,
          citta,
          zona: zona || detectedZone,
          cap,
          sito,
          telefono,
          whatsapp,
          email
        });
      } else {
        const cur = dedup.get(key);
        if (cur.cap === "99999" && cap !== "99999") cur.cap = cap;
        if (!cur.telefono && telefono) cur.telefono = telefono;
        if (!cur.whatsapp && whatsapp) cur.whatsapp = whatsapp;
        if (!cur.sito && sito) cur.sito = sito;
        if (!cur.email && email) cur.email = email;
        if (info.length > cur.info.length) cur.info = info;
      }
    }

    const items = Array.from(dedup.values())
      .sort((a, b) => {
        if (a.cap !== b.cap) return a.cap.localeCompare(b.cap, "it");
        return a.nome.localeCompare(b.nome, "it");
      })
      .slice(0, limit);

    return res.json({ citta, zona: zona || "Tutte", count: items.length, items });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Errore estrazione" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server avviato su porta ${PORT}`);
});
