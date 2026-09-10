/* ===========================================================================
   sync.js  –  holt die Schulen aus Pipedrive und schreibt schulen.json

   Wird von GitHub automatisch alle 30 Minuten ausgefuehrt.
   Der Pipedrive-Token steht NICHT in dieser Datei, sondern liegt bei GitHub
   unter "Secrets". Diese Datei muss deshalb nicht angepasst werden.
   =========================================================================== */

import { writeFile } from "node:fs/promises";

const TOKEN = process.env.PIPEDRIVE_TOKEN;
const FIRMA = process.env.PIPEDRIVE_FIRMA;

if (!TOKEN || !FIRMA) {
  console.error("PIPEDRIVE_TOKEN oder PIPEDRIVE_FIRMA fehlt.");
  console.error("Bitte bei GitHub unter Settings > Secrets and variables >");
  console.error("Actions als Repository secret anlegen.");
  process.exit(1);
}

/* ---------------------------------------------------------------------------
   Einstellungen – hier duerft ihr aendern
   --------------------------------------------------------------------------- */

// Welche Stages auf der oeffentlichen Karte erscheinen duerfen.
// Zeichengenau so schreiben wie in Pipedrive.
const OEFFENTLICHE_STAGES = ["Vertrag-Abschluss"];

// Farbe je Stage.
const FARBEN = {
  "Vertrag-Abschluss": "gruen",
  "Interessiert-Kontaktaufnahme": "gelb",
  "In Bearbeitung": "orange",
  "Verloren": "rot",
};

// Name der Pipeline, in der die Schul-Deals liegen.
const PIPELINE = "Schulpartner";

/* ---------------------------------------------------------------------------
   Ab hier nichts mehr aendern
   --------------------------------------------------------------------------- */

const BASIS = `https://${FIRMA}.pipedrive.com/api/v1`;

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

    await new Promise((r) => setTimeout(r, 200)); // Rate Limit schonen
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

async function main() {
  const tabelle = await feldTabelle();

  // Stage-Nummer -> Name und Pipeline
  const pipelines = {};
  for (const p of await pipedrive("pipelines")) pipelines[p.id] = p.name;

  const stages = {};
  for (const s of await pipedrive("stages")) {
    stages[s.id] = { name: s.name, pipeline: pipelines[s.pipeline_id] ?? "" };
  }

  // Pro Organisation den zuletzt geaenderten Schul-Deal merken
  const dealJeOrg = {};
  for (const deal of await pipedrive("deals", { status: "all_not_deleted" })) {
    const orgId =
      typeof deal.org_id === "object" && deal.org_id !== null
        ? deal.org_id.value
        : deal.org_id;
    if (!orgId) continue;

    const stage = stages[deal.stage_id];
    if (!stage || stage.pipeline !== PIPELINE) continue;

    const bisher = dealJeOrg[orgId];
    if (!bisher || (deal.update_time ?? "") > (bisher.update_time ?? "")) {
      dealJeOrg[orgId] = { ...deal, _stage: stage.name };
    }
  }

  const schulen = [];
  let ohneKoordinaten = 0;
  let keineSchule = 0;

  for (const org of await pipedrive("organizations")) {
    const typ = eigenesFeld(org, tabelle, "Kontakttyp");
    if (typ === null || typ.trim().toLowerCase() !== "schule") {
      keineSchule++;
      continue;
    }

    const lat = org.address_lat;
    const lon = org.address_long;
    if (lat === null || lat === undefined || lon === null || lon === undefined) {
      ohneKoordinaten++;
      continue;
    }

    const stage = dealJeOrg[org.id]?._stage ?? null;
    if (stage === null || !OEFFENTLICHE_STAGES.includes(stage)) continue;

    // Nur diese fuenf Angaben landen in der oeffentlichen Datei.
    schulen.push({
      name: org.name ?? null,
      plz: org.address_postal_code ?? null,
      ort: org.address_locality ?? null,
      lat: Number(lat),
      lon: Number(lon),
      farbe: FARBEN[stage] ?? "gruen",
    });
  }

  schulen.sort((a, b) => String(a.name).localeCompare(String(b.name), "de"));

  await writeFile(
    "schulen.json",
    JSON.stringify({ stand: new Date().toISOString(), schulen }, null, 1),
    "utf-8"
  );

  console.log(`${schulen.length} Schulen geschrieben.`);
  console.log(`Uebersprungen: ${keineSchule} ohne Kontakttyp "Schule", `
            + `${ohneKoordinaten} ohne Koordinaten.`);

  if (schulen.length === 0) {
    console.warn("");
    console.warn("ACHTUNG: keine einzige Schule gefunden.");
    console.warn("Haeufigste Ursache: die Stage-Bezeichnung in");
    console.warn("OEFFENTLICHE_STAGES stimmt nicht mit Pipedrive ueberein.");
    console.warn("Vorhandene Stages in der Pipeline " + PIPELINE + ":");
    for (const s of Object.values(stages)) {
      if (s.pipeline === PIPELINE) console.warn("  - " + s.name);
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
