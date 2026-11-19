const express = require("express");
const path = require("path");
const {
  makeLeadKey,
  upsertLeadsBatch,
  updateLeadAndLogHistory,
  queryLeads,
  queryHistory,
  db
} = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "vocalis-setter-db", timestamp: new Date().toISOString() });
});

// Lista lead dal DB (supporta ?setter=, ?citta=, ?stato=, ?q=, ?richiami=)
app.get("/api/db/leads", (req, res) => {
  try {
    const rows = queryLeads({
      citta: req.query.citta || "",
      stato: req.query.stato || "",
      setter: req.query.setter || "",
      q: req.query.q || "",
      soloRichiami: req.query.richiami || ""
    });
    res.json({ ok: true, count: rows.length, items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inserisce o aggiorna lead in batch su SQLite (cosi' appaiono a tutti i setter)
app.post("/api/db/leads/bulk", (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const normalized = items
      .map((r) => {
        const nome = String(r.nome || "").trim();
        const citta = String(r.citta || "Italia").trim();
        if (!nome) return null;
        return {
          id: r.id || makeLeadKey(nome, citta),
          nome,
          cap: String(r.cap || "99999").trim() || "99999",
          citta,
          zona: String(r.zona || "Centro").trim(),
          info: String(r.info || "").trim(),
          telefono: String(r.telefono || "").trim(),
          whatsapp: String(r.whatsapp || "").trim(),
          sito: String(r.sito || "").trim(),
          email: String(r.email || "").trim(),
          stato_chiamata: String(r.stato_chiamata || r.statoChiamata || "Da chiamare").trim(),
          setter: String(r.setter || "").trim(),
          note: String(r.note || "").trim(),
          data_richiamo: String(r.data_richiamo || r.dataRichiamo || "").trim(),
          risposta_cliente: String(r.risposta_cliente || r.rispostaCliente || "").trim()
        };
      })
      .filter(Boolean);

    const stats = upsertLeadsBatch(normalized);
    res.json({ ok: true, ...stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Aggiorna singolo lead e scrive nello storico chiamate/risposte/richiami
app.patch("/api/db/leads/:id", (req, res) => {
  try {
    const updated = updateLeadAndLogHistory(
      req.params.id,
      req.body || {},
      req.body.logHistory !== false
    );
    if (!updated) {
      return res.status(404).json({ error: "Lead non trovato" });
    }
    res.json({ ok: true, item: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Elimina un lead se necessario
app.delete("/api/db/leads/:id", (req, res) => {
  try {
    const info = db.prepare("DELETE FROM leads WHERE id = ?").run(req.params.id);
    res.json({ ok: true, deleted: info.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Storico risposte, chiamate e richiami
app.get("/api/db/history", (req, res) => {
  try {
    const rows = queryHistory({
      stato: req.query.stato || "",
      setter: req.query.setter || "",
      soloRichiami: req.query.richiami || "",
      limit: req.query.limit || 200
    });
    res.json({ ok: true, count: rows.length, items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Vocalis Setter DB in ascolto sulla porta ${PORT}`);
});
