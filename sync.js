/* ===========================================================================
   sync.js  –  holt die Schulen aus Pipedrive und schreibt schulen.json

   Wird von GitHub automatisch alle 30 Minuten ausgefuehrt.
   Der Pipedrive-Token steht NICHT in dieser Datei, sondern liegt bei GitHub
   unter "Secrets".

   Weil in Pipedrive keine Koordinaten hinterlegt sind, ermittelt dieses
   Skript sie selbst ueber OpenStreetMap und merkt sie sich dauerhaft in
   koordinaten.json. Jede Adresse wird also nur ein einziges Mal abgefragt.
   =========================================================================== */

import { writeFile, readFile } from "node:fs/promises";

const TOKEN = process.env.PIPEDRIVE_TOKEN;
const FIRMA = process.env.PIPEDRIVE_FIRMA;

if (!TOKEN || !FIRMA) {
  console.error("PIPEDRIVE_TOKEN oder PIPEDRIVE_FIRMA fehlt.");
  process.exit(1);
}

/* ---------------------------------------------------------------------------
   Einstellungen – hier duerft ihr aendern
   --------------------------------------------------------------------------- */

// Welche Stages auf der oeffentlichen Karte erscheinen duerfen.
const OEFFENTLICHE_STAGES = [
  "Rahmenvertrag unterzeichnet",
  "Follow Up Partner",
  "Unternehmen interessiert",
  "Vertragsabschluss mit Unternehmen",
  "Säule geliefert",
];

// Farbe je Stage.
const FARBEN = {
  // gruen = Säule steht bzw. Werbekunde gewonnen
  "Säule geliefert": "gruen",
  "Vertragsabschluss mit Unternehmen": "gruen",
  // orange = Rahmenvertrag steht, Werbekunden werden noch gesucht
  "Unternehmen interessiert": "orange",
  "Follow Up Partner": "orange",
  "Rahmenvertrag unterzeichnet": "orange",
  // gelb = noch kein Vertrag (nur intern)
  "Kontaktaufnahme": "gelb",
  "Interessiert": "gelb",
};

// Name der Pipeline, in der die Schul-Deals liegen.
const PIPELINE = "Schulpartner";

// Wie viele neue Adressen pro Durchlauf hoechstens nachgeschlagen werden.
// OpenStreetMap erlaubt eine Abfrage pro Sekunde, deshalb portionsweise.
const NEUE_ADRESSEN_PRO_LAUF = 250;

/* ---------------------------------------------------------------------------
   Ab hier nichts mehr aendern
   --------------------------------------------------------------------------- */

const BASIS = `https://${FIRMA}.pipedrive.com/api/v1`;
const KONTAKT = "schulkarte@lehrlingssaeule.at";

const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ruft eine Pipedrive-Adresse auf und blaettert durch alle Seiten. */
async function pipedrive(pfad, extra = {}) {
  const alles = [];
  let start = 0;

  while (true) {
    const params = new URLSearchParams({
      ...extra,
      api_token: TOKEN,
      start: String(start),
      limit: "500",
    });

    const antwort = await fetch(`${BASIS}/${pfad}?${params}`);

    if (antwort.status === 401) {
      throw new Error("Pipedrive lehnt den Token ab. Secret PIPEDRIVE_TOKEN pruefen.");
    }
    if (!antwort.ok) {
      throw new Error(`Pipedrive antwortet mit ${antwort.status} bei ${pfad}`);
    }

    const daten = await antwort.json();
    alles.push(...(daten.data ?? []));

    const seite = daten.additional_data?.pagination ?? {};
    if (!seite.more_items_in_collection) break;
    start = seite.next_start;

    await schlaf(200);
  }

  return alles;
}

/** Uebersetzungstabelle: lesbarer Feldname -> interner Schluessel. */
async function feldTabelle() {
  const tabelle = {};
  for (const feld of await pipedrive("organizationFields")) {
    const optionen = {};
    for (const o of feld.options ?? []) optionen[String(o.id)] = o.label;
    tabelle[String(feld.name).trim()] = { key: feld.key, optionen };
  }
  return tabelle;
}

function eigenesFeld(org, tabelle, name) {
  const eintrag = tabelle[name];
  if (!eintrag) return null;
  const wert = org[eintrag.key];
  if (wert === null || wert === undefined || wert === "") return null;
  return eintrag.optionen[String(wert)] ?? String(wert);
}

/* ---------------------------------------------------------------------------
   Geokodierung
   --------------------------------------------------------------------------- */

async function ladeZwischenspeicher() {
  try {
    return JSON.parse(await readFile("koordinaten.json", "utf-8"));
  } catch {
    return {};
  }
}

function adressSchluessel(org) {
  // Pipedrive liefert im Feld "address" bereits die vollstaendige Adresse,
  // z.B. "Konstanziagasse 50, Wien, Wien 1220". Postleitzahl und Ort noch
  // einmal anzuhaengen macht die Suche unbrauchbar.
  const voll = String(org.address ?? "").replace(/\s+/g, " ").trim();
  if (voll) return voll;

  return [org.address_postal_code, org.address_locality]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strasse und Hausnummer, ohne PLZ und Ort. */
function strasseUndNummer(org) {
  const weg = String(org.address_route ?? "").trim();
  const nr = String(org.address_street_number ?? "").trim();
  if (weg) return (weg + " " + nr).trim();

  // Ersatzweise der erste Teil des vollen Adressfelds.
  const ersterTeil = String(org.address ?? "").split(",")[0].trim();
  return ersterTeil || null;
}

/** Fragt OpenStreetMap nach einer Adresse. Gibt null zurueck, wenn nichts passt. */
async function geokodiere(adresse) {
  const params = new URLSearchParams({
    q: adresse,
    format: "json",
    limit: "1",
    countrycodes: "at",
  });

  const antwort = await fetch(
    `https://nominatim.openstreetmap.org/search?${params}`,
    { headers: { "User-Agent": `Lehrlingssaeule-Schulkarte (${KONTAKT})` } }
  );

  if (!antwort.ok) {
    console.log(`  Adressdienst antwortet ${antwort.status} bei: ${adresse}`);
    return null;
  }

  const treffer = await antwort.json();
  if (!treffer.length) {
    console.log(`  kein Treffer fuer: ${adresse}`);
    return null;
  }

  return { lat: Number(treffer[0].lat), lon: Number(treffer[0].lon) };
}

/* ---------------------------------------------------------------------------
   Hauptteil
   --------------------------------------------------------------------------- */

async function main() {
  const tabelle = await feldTabelle();

  const pipelines = {};
  for (const p of await pipedrive("pipelines")) pipelines[p.id] = p.name;

  const stages = {};
  for (const s of await pipedrive("stages")) {
    stages[s.id] = { name: s.name, pipeline: pipelines[s.pipeline_id] ?? "" };
  }

  // Pro Organisation den zuletzt geaenderten Schul-Deal merken.
  const dealJeOrg = {};
  const rohZaehler = {};
  for (const deal of await pipedrive("deals", { status: "all_not_deleted" })) {
    const orgId =
      typeof deal.org_id === "object" && deal.org_id !== null
        ? deal.org_id.value
        : deal.org_id;
    if (!orgId) continue;

    const stage = stages[deal.stage_id];
    if (!stage || stage.pipeline !== PIPELINE) continue;

    rohZaehler[stage.name] = (rohZaehler[stage.name] ?? 0) + 1;

    const bisher = dealJeOrg[orgId];
    if (!bisher || (deal.update_time ?? "") > (bisher.update_time ?? "")) {
      dealJeOrg[orgId] = { ...deal, _stage: stage.name };
    }
  }

  // Nur Schulen einsammeln, die auch wirklich auf die Karte sollen.
  const kandidaten = [];
  const stageZaehler = {};
  const orgNachId = {};

  for (const org of await pipedrive("organizations")) {
    orgNachId[org.id] = org;

    const typ = eigenesFeld(org, tabelle, "Kontakttyp");
    if (typ === null || typ.trim().toLowerCase() !== "schule") continue;

    const stage = dealJeOrg[org.id]?._stage ?? null;
    if (stage) stageZaehler[stage] = (stageZaehler[stage] ?? 0) + 1;

    if (stage === null || !OEFFENTLICHE_STAGES.includes(stage)) continue;

    kandidaten.push({ org, stage });
  }

  console.log("Deals je Stage (roh, vor Zusammenfassung je Organisation):");
  for (const [s, n] of Object.entries(rohZaehler).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${s}`);
  }

  console.log("");
  console.log("Pruefung der Deals in oeffentlichen Stages:");
  const oeffDeals = Object.entries(dealJeOrg).filter(([, d]) => OEFFENTLICHE_STAGES.includes(d._stage));
  console.log(`  Organisationen mit Deal in oeffentlichen Stages: ${oeffDeals.length}`);
  for (const [orgId, deal] of oeffDeals) {
    const org = orgNachId[orgId];
    if (!org) { console.log(`  OHNE ORGANISATION: Deal "${deal.title}"`); continue; }
    if (!kandidaten.some(k => k.org.id === org.id)) {
      const typ = eigenesFeld(org, tabelle, "Kontakttyp");
      console.log(`  AUSGESCHLOSSEN: ${org.name} -- Kontakttyp = "${typ}"`);
    }
  }

  console.log("");
  console.log("Schulen je Stage:");
  for (const [s, n] of Object.entries(stageZaehler).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${s}`);
  }
  console.log(`Fuer die oeffentliche Karte vorgesehen: ${kandidaten.length}`);

  // Koordinaten: erst aus Pipedrive, dann aus dem Zwischenspeicher,
  // sonst neu nachschlagen.
  const cache = await ladeZwischenspeicher();
  let ausPipedrive = 0, ausCache = 0, neu = 0, ohneAdresse = 0, nichtGefunden = 0;
  let budget = NEUE_ADRESSEN_PRO_LAUF;

  const schulen = [];

  for (const { org, stage } of kandidaten) {
    let lat = org.address_lat;
    let lon = org.address_long;

    if (lat != null && lon != null) {
      ausPipedrive++;
    } else {
      const schluessel = adressSchluessel(org);

      if (!schluessel) {
        ohneAdresse++;
        continue;
      }

      if (cache[schluessel] === null) {
        nichtGefunden++;
        continue;
      }

      if (cache[schluessel]) {
        ({ lat, lon } = cache[schluessel]);
        ausCache++;
      } else if (budget > 0) {
        budget--;
        const gefunden = await geokodiere(schluessel);
        await schlaf(1100);

        cache[schluessel] = gefunden;
        if (!gefunden) {
          nichtGefunden++;
          continue;
        }
        ({ lat, lon } = gefunden);
        neu++;
      } else {
        continue;
      }
    }

    schulen.push({
      name: org.name ?? null,
      strasse: strasseUndNummer(org),
      plz: org.address_postal_code ?? null,
      ort: org.address_locality ?? null,
      lat: Number(lat),
      lon: Number(lon),
      farbe: FARBEN[stage] ?? "gruen",
    });
  }

  schulen.sort((a, b) => String(a.name).localeCompare(String(b.name), "de"));

  await writeFile("koordinaten.json", JSON.stringify(cache, null, 1), "utf-8");
  await writeFile(
    "schulen.json",
    JSON.stringify({ stand: new Date().toISOString(), schulen }, null, 1),
    "utf-8"
  );

  console.log("");
  console.log(`${schulen.length} Schulen auf der Karte.`);
  console.log(`  aus Pipedrive: ${ausPipedrive}`);
  console.log(`  aus Zwischenspeicher: ${ausCache}`);
  console.log(`  neu nachgeschlagen: ${neu}`);
  console.log(`  ohne Adresse: ${ohneAdresse}`);
  console.log(`  Adresse nicht gefunden: ${nichtGefunden}`);

  const offen = kandidaten.length - schulen.length - ohneAdresse - nichtGefunden;
  if (offen > 0) {
    console.log("");
    console.log(`Noch offen: ${offen}. Kommen in den naechsten Durchlaeufen dran.`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
