# Vocalis • Estrattore Lead Ristoranti su Render

Struttura pronta per il deploy su **Render** (Web Service Node.js):

- `package.json` — dipendenze (`express`) e script `npm start`
- `server.js` — endpoint `GET /api/restaurants` che interroga Photon (con fallback Nominatim), filtra per città italiana, rimuove duplicati e serve `public/index.html`
- `public/index.html` — interfaccia web per filtrare città/zona/setter/stato, modificare al volo Sito/Telefono/WhatsApp/Email/Note ed esportare in `.xlsx`

## Deploy su Render
1. Carica questi file su un repository GitHub (o crea un Web Service collegato al repo).
2. Imposta:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
3. Avvia il servizio e apri l'URL `https://<tuo-servizio>.onrender.com`.
