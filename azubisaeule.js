/* ===========================================================================
   azubisaeule.js  –  holt die Azubisäule-Schulen (Deutschland) und schreibt
   azubisaeule.json.

   Quelle: die öffentliche Karte auf azubisaeule.de/unternehmen/standorte/
   (eingebettet von https://karte.srv1298492.hstgr.cloud/). Dort liegen die
   Schulen fertig mit Koordinaten in schulen.json. Kein Token nötig.

   Wird von GitHub einmal pro Woche ausgeführt (.github/workflows/azubisaeule.yml).

   Aufruf:  node azubisaeule.js            -> nur Name + Koordinaten (öffentlich)
            node azubisaeule.js --adresse  -> zusätzlich Straße, PLZ, Ort (intern)
   =========================================================================== */

import { writeFile, readFile } from "node:fs/promises";

const QUELLE = "https://karte.srv1298492.hstgr.cloud/schulen.json";
const DATEI = "azubisaeule.json";
const MIT_ADRESSE = process.argv.includes("--adresse");

// Schutz: Liefert die Quelle auf einmal viel weniger Schulen als bisher
// (z.B. Seite kaputt), wird die alte Datei NICHT überschrieben.
const MINDESTANTEIL = 0.8;

function zerlegeAdresse(adresse) {
  const teile = String(adresse ?? "")
    .replace(/,?\s*(Deutschland|Germany)\s*$/i, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  let strasse = null, plz = null, ort = null;
  for (const [i, t] of teile.entries()) {
    const m = t.match(/\b(\d{5})\s+(.+)/);
    if (m) {
      plz = m[1];
      ort = m[2];
      const davor = t.slice(0, m.index).trim();
      strasse = davor || (i > 0 ? teile[i - 1] : null);
      break;
    }
  }
  const rest = teile.filter((t) => !/\b\d{5}\b/.test(t));
  if (!strasse) {
    strasse =
      rest.find((t) => /\d/.test(t) || /(straße|str\.|weg|platz|gasse|allee|ring|tor)\b/i.test(t)) ?? null;
  }
  if (!ort) ort = rest.find((t) => t !== strasse) ?? null;
  return { strasse, plz, ort };
}

async function main() {
  const antwort = await fetch(QUELLE, {
    headers: { "User-Agent": "Lehrlingssaeule-Schulkarte (schulkarte@lehrlingssaeule.at)" },
  });
  if (!antwort.ok) throw new Error(`Quelle antwortet mit ${antwort.status}`);
  const daten = await antwort.json();

  const roh = Array.isArray(daten) ? daten : daten.schulen ?? [];
  const schulen = [];
  for (const s of roh) {
    if (String(s.land ?? "").toUpperCase() === "AT") continue; // AT-Schulen kommen schon aus Pipedrive
    const lat = Number(s.lat);
    const lon = Number(s.lng ?? s.lon);
    if (!s.name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const eintrag = { name: String(s.name).trim() };
    if (MIT_ADRESSE) Object.assign(eintrag, zerlegeAdresse(s.adresse));
    eintrag.lat = lat;
    eintrag.lon = lon;
    schulen.push(eintrag);
  }
  schulen.sort((a, b) => a.name.localeCompare(b.name, "de"));

  let bisher = 0;
  try {
    bisher = (JSON.parse(await readFile(DATEI, "utf-8")).schulen ?? []).length;
  } catch {}

  console.log(`Quelle: ${roh.length} Einträge, davon ${schulen.length} mit Koordinaten. Bisher: ${bisher}.`);

  if (schulen.length === 0 || (bisher > 0 && schulen.length < bisher * MINDESTANTEIL)) {
    throw new Error("Deutlich weniger Schulen als bisher – Datei wird nicht überschrieben. Quelle prüfen.");
  }

  const text =
    '{\n "quelle": "' + QUELLE + '",\n "schulen": [\n' +
    schulen.map((s) => "  " + JSON.stringify(s)).join(",\n") +
    "\n ]\n}\n";
  await writeFile(DATEI, text, "utf-8");
  console.log(`${schulen.length} Schulen in ${DATEI} geschrieben.`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
