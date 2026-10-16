import React, { useState, useCallback } from "react";

// ============================================================
// 1. Lecture ZIP (parseur maison : pas de lib externe dispo)
// ============================================================
async function readZip(buf) {
  const bytes = new Uint8Array(buf);
  const td = new TextDecoder();
  // Trouver End Of Central Directory (signature 0x06054b50)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65558; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i; break;
    }
  }
  if (eocd < 0) throw new Error("Fichier ZIP invalide (répertoire central introuvable).");
  const nbEntries = new DataView(bytes.buffer, eocd + 10).getUint16(0, true);
  let off = new DataView(bytes.buffer, eocd + 16).getUint32(0, true);
  const entries = {};
  for (let k = 0; k < nbEntries; k++) {
    const sig = new DataView(bytes.buffer, off).getUint32(0, true);
    if (sig !== 0x02014b50) break;
    const v = new DataView(bytes.buffer, off);
    const method = v.getUint16(10, true);
    const compSize = v.getUint32(20, true);
    const nameLen = v.getUint16(28, true);
    const extraLen = v.getUint16(30, true);
    const commLen = v.getUint16(32, true);
    const localOff = v.getUint32(42, true);
    const name = td.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    // Local header
    const lv = new DataView(bytes.buffer, localOff);
    const lnameLen = lv.getUint16(26, true);
    const lextraLen = lv.getUint16(28, true);
    const dataStart = localOff + 30 + lnameLen + lextraLen;
    const data = bytes.subarray(dataStart, dataStart + compSize);
    entries[name.replace(/^\.\//, "")] = { method, data };
    off += 46 + nameLen + extraLen + commLen;
  }
  const out = {};
  for (const [name, e] of Object.entries(entries)) {
    if (e.method === 0) {
      out[name] = td.decode(e.data);
    } else if (e.method === 8) {
      const ds = new DecompressionStream("deflate-raw");
      const stream = new Blob([e.data]).stream().pipeThrough(ds);
      out[name] = await new Response(stream).text();
    } else {
      throw new Error(`Méthode de compression non supportée pour ${name}.`);
    }
  }
  return out;
}

// ============================================================
// 2. Parseur CSV
// ============================================================
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  text = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.some(c => c !== "")).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
    return o;
  });
}

// ============================================================
// 3. Validation GTFS (anomalies bloquantes)
// ============================================================
const REQUIRED_FIELDS = {
  "calendar.txt": ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"],
  "calendar_dates.txt": ["service_id", "date", "exception_type"],
  "trips.txt": ["route_id", "service_id", "trip_id"],
};

function validateGTFS(files) {
  const errors = [];
  const warnings = [];
  const need = ["calendar.txt", "calendar_dates.txt", "trips.txt"];
  for (const f of need) {
    if (!files[f]) errors.push(`Fichier obligatoire manquant : ${f}`);
  }
  if (errors.length) return { errors, warnings };

  const calendar = parseCSV(files["calendar.txt"]);
  const calDates = parseCSV(files["calendar_dates.txt"]);
  const trips = parseCSV(files["trips.txt"]);

  if (calendar.length === 0 && calDates.length === 0)
    errors.push("calendar.txt et calendar_dates.txt sont tous les deux vides : aucun service défini.");

  // Champs requis
  for (const [fname, fields] of Object.entries(REQUIRED_FIELDS)) {
    const text = files[fname]; if (!text) continue;
    const headers = text.split("\n")[0].split(",").map(h => h.replace(/\r|"/g, "").trim());
    for (const f of fields) if (!headers.includes(f)) errors.push(`${fname} : colonne requise manquante "${f}"`);
  }

  // Chaque service référencé par trips doit exister
  const serviceIds = new Set(calendar.map(r => r.service_id));
  calDates.forEach(r => serviceIds.add(r.service_id));
  const tripServiceIds = [...new Set(trips.map(r => r.service_id))];
  const orphans = tripServiceIds.filter(sid => sid && !serviceIds.has(sid));
  if (orphans.length)
    errors.push(`trips.txt référence des service_id inconnus dans calendar/calendar_dates : ${orphans.slice(0, 5).join(", ")}${orphans.length > 5 ? "…" : ""}`);

  // Formats de dates et jours de semaine
  const dateRe = /^\d{8}$/;
  calendar.forEach((r, i) => {
    if (!dateRe.test(r.start_date) || !dateRe.test(r.end_date))
      errors.push(`calendar.txt ligne ${i + 2} : start_date/end_date invalide (attendu AAAAMMJJ).`);
    else if (r.start_date > r.end_date)
      errors.push(`calendar.txt ligne ${i + 2} : start_date > end_date.`);
    const days = [r.monday, r.tuesday, r.wednesday, r.thursday, r.friday, r.saturday, r.sunday];
    if (days.some(d => d !== "0" && d !== "1"))
      errors.push(`calendar.txt ligne ${i + 2} : jour de semaine invalide (attendu 0 ou 1).`);
    if (days.every(d => d === "0") && !calDates.some(c => c.service_id === r.service_id))
      warnings.push(`calendar.txt ligne ${i + 2} : service "${r.service_id}" n'a aucun jour actif.`);
  });
  calDates.forEach((r, i) => {
    if (!dateRe.test(r.date))
      errors.push(`calendar_dates.txt ligne ${i + 2} : date invalide "${r.date}".`);
    if (r.exception_type !== "1" && r.exception_type !== "2")
      errors.push(`calendar_dates.txt ligne ${i + 2} : exception_type invalide "${r.exception_type}" (attendu 1 ou 2).`);
  });
  // trip_id en doublon
  const seen = new Set();
  trips.forEach(r => {
    if (seen.has(r.trip_id)) warnings.push(`trips.txt : trip_id dupliqué "${r.trip_id}".`);
    seen.add(r.trip_id);
  });
  return { errors, warnings, calendar, calDates, trips };
}

// ============================================================
// 4. Calcul des dates actives par service
// ============================================================
function ymdToInt(s) { return parseInt(s, 10); }
function intToYmd(n) { return String(n); }

function serviceActiveDates(calendar, calDates) {
  const sets = {}; // service_id -> Set<int yyyymmdd>
  for (const r of calendar) {
    const set = sets[r.service_id] || (sets[r.service_id] = new Set());
    const start = ymdToInt(r.start_date), end = ymdToInt(r.end_date);
    const pattern = [r.sunday, r.monday, r.tuesday, r.wednesday, r.thursday, r.friday, r.saturday].map(Number);
    let d = new Date(Date.UTC(Math.floor(start / 10000), Math.floor((start % 10000) / 100) - 1, start % 100));
    const endD = new Date(Date.UTC(Math.floor(end / 10000), Math.floor((end % 10000) / 100) - 1, end % 100));
    let guard = 0;
    while (d <= endD && guard++ < 4000) {
      if (pattern[d.getUTCDay()] === 1) {
        const ymd = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
        set.add(ymd);
      }
      d = new Date(d.getTime() + 86400000);
    }
  }
  for (const r of calDates) {
    const set = sets[r.service_id] || (sets[r.service_id] = new Set());
    if (r.exception_type === "1") set.add(ymdToInt(r.date));
    else set.delete(ymdToInt(r.date));
  }
  return sets;
}

// ============================================================
// 5. Composants UI
// ============================================================
const MOIS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
const JOURS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

function ymdToDate(n) { return new Date(Math.floor(n / 10000), Math.floor((n % 10000) / 100) - 1, n % 100); }
function dateToYmd(d) { return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }

// ============================================================
// Calendrier scolaire officiel (métropole, hors Corse)
// Sources : arrêtés ministériels — dates officielles 2025-2026 et 2026-2027
// Convention : plage de vacances [start, end] inclus (end = veille de la reprise)
// ============================================================
const SCHOOL_VACATIONS = {
  // petites = Toussaint, Noël, Hiver, Printemps, Pont de l'Ascension ; ete = grandes vacances
  "2025-2026": {
    common: [
      { type: "ete", start: 20250705, end: 20250831 },     // été 2025 (fin d'année scolaire 2024-2025)
      { type: "petites", start: 20251018, end: 20251102 }, // Toussaint (reprise 3 nov 2025)
      { type: "petites", start: 20251220, end: 20260104 }, // Noël (reprise 5 janv 2026)
      { type: "petites", start: 20260513, end: 20260517 }, // Pont de l'Ascension (reprise 18 mai 2026)
      { type: "ete", start: 20260704, end: 20260831 },     // été 2026 (rentrée 1er sept 2026)
    ],
    A: [ { type: "petites", start: 20260207, end: 20260222 }, { type: "petites", start: 20260404, end: 20260419 } ],
    B: [ { type: "petites", start: 20260214, end: 20260301 }, { type: "petites", start: 20260411, end: 20260426 } ],
    C: [ { type: "petites", start: 20260221, end: 20260308 }, { type: "petites", start: 20260418, end: 20260503 } ],
  },
  "2026-2027": {
    common: [
      { type: "petites", start: 20261017, end: 20261101 }, // Toussaint (reprise 2 nov 2026)
      { type: "petites", start: 20261219, end: 20270103 }, // Noël (reprise 4 janv 2027)
      { type: "petites", start: 20270505, end: 20270509 }, // Pont de l'Ascension (reprise 10 mai 2027)
      { type: "ete", start: 20270703, end: 20270831 },     // été 2027
    ],
    A: [ { type: "petites", start: 20270213, end: 20270228 }, { type: "petites", start: 20270410, end: 20270425 } ],
    B: [ { type: "petites", start: 20270220, end: 20270307 }, { type: "petites", start: 20270417, end: 20270502 } ],
    C: [ { type: "petites", start: 20270206, end: 20270221 }, { type: "petites", start: 20270403, end: 20270418 } ],
  },
};
// Couverture des données connues : les jours hors plage restent blancs
const SCHOOL_COVER_START = 20250705, SCHOOL_COVER_END = 20270831;

// Jours fériés (métropole) : fixes + basés sur Pâques
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}
function publicHolidays(year) {
  const easter = easterSunday(year);
  const mv = (days) => dateToYmd(new Date(easter.getTime() + days * 86400000));
  const fixed = [ year * 10000 + 101, year * 10000 + 501, year * 10000 + 508, year * 10000 + 714, year * 10000 + 815, year * 10000 + 1101, year * 10000 + 1111, year * 10000 + 1225 ];
  return new Set([ ...fixed, mv(1), mv(39), mv(50) ]); // lundi de Pâques, Ascension, lundi de Pentecôte
}
const FERIES = {};
for (let yy = 2024; yy <= 2030; yy++) FERIES[yy] = publicHolidays(yy);

// Statut scolaire d'un jour : "ferie" > "petites" > "ete" > "scolaire" > null
function schoolDayStatus(ymd, zone) {
  if (FERIES[Math.floor(ymd / 10000)]?.has(ymd)) return "ferie";
  for (const year of Object.values(SCHOOL_VACATIONS)) {
    const ranges = [...year.common, ...(year[zone] || [])];
    for (const r of ranges) {
      if (ymd >= r.start && ymd <= r.end) return r.type;
    }
  }
  if (ymd >= SCHOOL_COVER_START && ymd <= SCHOOL_COVER_END) return "scolaire";
  return null;
}
const SCHOOL_STYLE = {
  scolaire: { bg: "#dbeafe", label: "Période scolaire" },
  scolaire_we: { bg: "#eff6ff", label: "Week-end en période scolaire" },
  petites: { bg: "#fdba74", label: "Petites vacances" },
  ete: { bg: "#fcd34d", label: "Vacances d'été" },
  ferie: { bg: "#ef4444", label: "Jour férié" },
};

function Analysis({ result, zone }) {
  const [yearCursor, setYearCursor] = useState(() => ymdToDate(result.minDate).getFullYear());
  const [selectedDay, setSelectedDay] = useState(null);
  const { minDate, maxDate, dayList, uniqueCount, servicesCount, tripsCount, exceptionDays } = result;

  const minY = ymdToDate(minDate).getFullYear();
  const maxY = ymdToDate(maxDate).getFullYear();
  const span = Math.round((ymdToDate(maxDate) - ymdToDate(minDate)) / 86400000) + 1;
  const y = Math.min(Math.max(yearCursor, minY), maxY);

  // Palette de couleurs : une couleur par liste distincte de trips
  const PALETTE = ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#dc2626", "#0891b2", "#ca8a04", "#db2777", "#4d7c0f", "#7c3aed", "#0d9488", "#b45309"];
  const sigColors = (() => {
    // attribution d'une couleur par signature (liste de trips)
    const map = new Map();
    let idx = 0;
    const sortedDays = [...dayList.keys()].sort((a, b) => a - b);
    for (const ymd of sortedDays) {
      const list = dayList.get(ymd) || [];
      if (list.length === 0) continue;
      const sig = list.join("|");
      if (!map.has(sig)) {
        map.set(sig, PALETTE[idx % PALETTE.length]);
        idx++;
      }
    }
    return map;
  })();
  const colorOf = (ymd) => {
    const list = dayList.get(ymd) || [];
    return list.length === 0 ? null : sigColors.get(list.join("|"));
  };
  // résumé : une entrée par liste distincte, triée par première date d'apparition
  const sigSummary = (() => {
    const seen = new Map(); // sig -> { firstDate, count, color }
    const sortedDays = [...dayList.keys()].sort((a, b) => a - b);
    for (const ymd of sortedDays) {
      const list = dayList.get(ymd) || [];
      if (list.length === 0) continue;
      const sig = list.join("|");
      if (!seen.has(sig)) seen.set(sig, { firstDate: ymd, count: 0, color: sigColors.get(sig) });
      seen.get(sig).count++;
    }
    return [...seen.entries()].map(([sig, info]) => ({ ...info, size: (sig.match(/\|/g) || []).length + 1 }));
  })();

  // --- Calendrier scolaire ---
  const [namingStarted, setNamingStarted] = useState(false);
  const schoolCounts = (() => {
    const counts = { scolaire: 0, scolaire_we: 0, petites: 0, ete: 0, ferie: 0 };
    const d0 = ymdToDate(minDate), d1 = ymdToDate(maxDate);
    for (let d = new Date(d0); d <= d1; d = new Date(d.getTime() + 86400000)) {
      const ymd = dateToYmd(d);
      const st = schoolDayStatus(ymd, zone);
      if (!st) continue;
      const we = d.getDay() === 0 || d.getDay() === 6;
      counts[st === "scolaire" && we ? "scolaire_we" : st]++;
    }
    return counts;
  })();
  const SchoolMonth = ({ yy, mm }) => {
    const first = new Date(yy, mm, 1);
    const mEnd = new Date(yy, mm + 1, 0).getDate();
    const offset = (first.getDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < offset; i++) cells.push(null);
    for (let d = 1; d <= mEnd; d++) {
      const dt = new Date(yy, mm, d);
      const ymd = dateToYmd(dt);
      const st = schoolDayStatus(ymd, zone);
      const we = dt.getDay() === 0 || dt.getDay() === 6;
      cells.push({ ymd, d, st: st === "scolaire" && we ? "scolaire_we" : st });
    }
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-2">
        <div className="text-center text-xs font-semibold text-gray-700 mb-1">{MOIS[mm]}</div>
        <div className="grid grid-cols-7 gap-[1px]">
          {JOURS.map(j => <div key={j} className="text-center text-[9px] text-gray-400">{j[0]}</div>)}
          {cells.map((c, i) => c === null ? (
            <div key={"e" + i} />
          ) : (
            <div
              key={c.ymd}
              title={c.st ? SCHOOL_STYLE[c.st].label : "Hors période couverte"}
              className="h-5 flex items-center justify-center text-[10px] rounded-sm"
              style={{
                backgroundColor: c.st ? SCHOOL_STYLE[c.st].bg : "#ffffff",
                color: c.st === "ferie" ? "#fff" : c.st ? "#374151" : "#d1d5db",
              }}
            >
              {c.d}
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Mini-calendrier d'un mois
  const MiniMonth = ({ yy, mm }) => {
    const first = new Date(yy, mm, 1);
    const daysInMonth = new Date(yy, mm + 1, 0).getDate();
    const offset = (first.getDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < offset; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const ymd = yy * 10000 + (mm + 1) * 100 + d;
      const inRange = ymd >= minDate && ymd <= maxDate;
      const color = inRange ? colorOf(ymd) : null;
      cells.push({ ymd, d, inRange, hasTrips: color !== null, color });
    }
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-2">
        <div className="text-center text-xs font-semibold text-gray-700 mb-1">{MOIS[mm]}</div>
        <div className="grid grid-cols-7 gap-[1px]">
          {JOURS.map(j => <div key={j} className="text-center text-[9px] text-gray-400">{j[0]}</div>)}
          {cells.map((c, i) => c === null ? (
            <div key={"e" + i} />
          ) : !c.inRange ? (
            <div key={c.ymd} className="h-5 flex items-center justify-center text-[10px] text-gray-300">{c.d}</div>
          ) : (
            <button
              key={c.ymd}
              onClick={() => setSelectedDay(c.ymd)}
              className={`h-5 w-full flex items-center justify-center text-[10px] rounded-sm border transition-colors ${
                selectedDay === c.ymd ? "ring-2 ring-offset-1 ring-gray-800 font-semibold"
                : c.hasTrips ? "border-transparent hover:brightness-110"
                : "bg-white text-gray-400 border-gray-200 hover:bg-gray-50"
              }`}
              style={c.hasTrips ? { backgroundColor: c.color, color: "#fff" } : undefined}
            >
              {c.d}
            </button>
          ))}
        </div>
      </div>
    );
  };

  const selList = selectedDay ? (dayList.get(selectedDay) || []) : [];
  const selDate = selectedDay ? ymdToDate(selectedDay) : null;

  return (
    <div className="space-y-6">
      {namingStarted && <NamingPage result={result} zone={zone} onBack={() => setNamingStarted(false)} />}
      {!namingStarted && (
      <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="rounded-xl border bg-blue-50 border-blue-200 p-4">
          <div className="text-xs text-blue-700 font-medium uppercase">Listes distinctes de trips</div>
          <div className="text-3xl font-bold text-blue-900">{uniqueCount}</div>
          <div className="text-xs text-blue-600">combinaisons différentes de trip_id</div>
        </div>
        <div className="rounded-xl border bg-gray-50 border-gray-200 p-4">
          <div className="text-xs text-gray-600 font-medium uppercase">Amplitude</div>
          <div className="text-3xl font-bold text-gray-800">{span} j</div>
          <div className="text-xs text-gray-500">{intToYmd(minDate)} → {intToYmd(maxDate)}</div>
        </div>
        <div className="rounded-xl border bg-gray-50 border-gray-200 p-4">
          <div className="text-xs text-gray-600 font-medium uppercase">Services</div>
          <div className="text-3xl font-bold text-gray-800">{servicesCount}</div>
          <div className="text-xs text-gray-500">service_id dans calendar</div>
        </div>
        <div className="rounded-xl border bg-gray-50 border-gray-200 p-4">
          <div className="text-xs text-gray-600 font-medium uppercase">Trips</div>
          <div className="text-3xl font-bold text-gray-800">{tripsCount}</div>
          <div className="text-xs text-gray-500">lignes dans trips.txt</div>
        </div>
      </div>

      {/* Calendrier scolaire (zone sélectionnée) */}
      <div className="rounded-xl border bg-white border-gray-200 shadow-sm">
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <button
            className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-50 disabled:opacity-30"
            disabled={y <= minY}
            onClick={() => setYearCursor(y - 1)}
          >← {y > minY ? y - 1 : ""}</button>
          <div className="font-semibold text-gray-800 text-lg">Calendrier scolaire — Zone {zone} · {y}</div>
          <div className="text-xs text-gray-400 max-w-xs text-right">Calendrier scolaire de la zone {zone} uniquement.<br />Aucune info GTFS ici, sauf l'étendue d'activité du réseau.</div>
          <button
            className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-50 disabled:opacity-30"
            disabled={y >= maxY}
            onClick={() => setYearCursor(y + 1)}
          >{y < maxY ? y + 1 : ""} →</button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 p-4">
          {Array.from({ length: 12 }, (_, mm) => <SchoolMonth key={mm} yy={y} mm={mm} />)}
        </div>
        <div className="flex flex-wrap items-center gap-4 px-4 pb-4 text-xs text-gray-600">
          {Object.entries(SCHOOL_STYLE).map(([key, s]) => (
            <span key={key} className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-sm border border-gray-300" style={{ backgroundColor: s.bg }}></span>{s.label}
              {schoolCounts[key] > 0 && <span className="text-gray-400">({schoolCounts[key]} j)</span>}
            </span>
          ))}
        </div>
      </div>

      {/* Lancement du processus de nommage */}
      <div className="flex justify-center">
        <button
          className="px-6 py-3 rounded-xl bg-purple-600 text-white font-semibold hover:bg-purple-700 transition-colors"
          onClick={() => setNamingStarted(true)}
        >
          Lancer le processus de nommage
        </button>
      </div>
      {namingStarted && <NamingPage result={result} zone={zone} onBack={() => setNamingStarted(false)} />}

      {/* Détail du jour sélectionné */}
      {selectedDay && (
        <div className="rounded-xl border bg-white border-gray-200 shadow-sm">
          <div className="flex items-center justify-between p-4 border-b border-gray-100">
            <div>
              <div className="font-semibold text-gray-800">
                {selDate.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                <span className="ml-2 text-sm text-gray-400">({intToYmd(selectedDay)})</span>
              </div>
              <div className="text-xs text-gray-500">
                {selList.length} trip(s) ce jour-là
              </div>
            </div>
            <button
              className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm hover:bg-gray-50"
              onClick={() => setSelectedDay(null)}
            >Fermer ✕</button>
          </div>
          {selList.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">Aucun trip ne circule ce jour-là.</div>
          ) : (
            <div className="max-h-72 overflow-y-auto p-4">
              <div className="flex flex-wrap gap-1.5">
                {selList.map(tid => (
                  <span key={tid} className="text-xs font-mono bg-blue-50 border border-blue-200 text-blue-800 rounded px-2 py-1">{tid}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      </div>
      )}
    </div>
  );
}

// ============================================================
// Page de nommage : une ligne par liste distincte
// ============================================================
const DAY_CODES = ["L", "M", "C", "J", "V", "S", "D"]; // lun->dim (C = mercredi, sans ambiguïté)
const DAY_NAMES = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

// Déduit une suggestion à partir des jours d'activité d'une liste
// Pour chaque statut scolaire couvert : préfixe période + motif des jours de semaine
// ex : "ScolaireB LMJV__" ou "ScolaireB LMJV__ + EteB __C____"
function suggestNaming(dates, zone) {
  const statDays = {}; // stat -> Set(0..6)
  for (const ymd of dates) {
    const d = ymdToDate(ymd);
    const st = schoolDayStatus(ymd, zone);
    if (!st) continue; // hors période couverte : ignoré pour la suggestion
    (statDays[st] || (statDays[st] = new Set())).add((d.getDay() + 6) % 7);
  }
  const PREFIX = { scolaire: `Scolaire${zone}`, petites: `PetitesVac${zone}`, ete: `Ete${zone}`, ferie: `Ferie${zone}` };
  const ORDER = ["scolaire", "petites", "ete", "ferie"];
  const parts = [];
  const allDays = new Set();
  for (const st of ORDER) {
    if (!statDays[st]) continue;
    for (const day of statDays[st]) allDays.add(day);
    let pattern = "_______";
    for (const day of statDays[st]) pattern = pattern.substring(0, day) + DAY_CODES[day] + pattern.substring(day + 1);
    parts.push(`${PREFIX[st]} ${pattern}`);
  }
  const fallback = dates.length
    ? `Liste${ymdToDate(dates[0]).getFullYear()}`
    : "Liste1";
  return { name: parts.length ? parts.join(" + ") : fallback, pattern: [...allDays].sort() };
}

// ============================================================
// Export : écriture CSV + ZIP (méthode stockée, CRC32)
// ============================================================
function csvField(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(headers, rows) {
  return [headers.join(",") , ...rows.map(r => headers.map(h => csvField(r[h])).join(","))].join("\n") + "\n";
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 8; t[n] = c; }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(files) { // files: { name: textContent }
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameU8 = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameU8.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true); dv.setUint16(12, 0x21, true); // heure/date fixes
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameU8.length, true); dv.setUint16(28, 0, true);
    local.set(nameU8, 30);
    parts.push(local, data);
    const cen = new Uint8Array(46 + nameU8.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameU8.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nameU8, 46);
    central.push(cen);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, eocd], { type: "application/zip" });
}

function NamingPage({ result, zone, onBack }) {
  const { dayList, uniqueCount } = result;
  // une entrée par liste distincte
  const distinct = React.useMemo(() => {
    const bySig = new Map();
    const sortedDays = [...dayList.keys()].sort((a, b) => a - b);
    for (const ymd of sortedDays) {
      const list = dayList.get(ymd) || [];
      if (list.length === 0) continue;
      const sig = list.join("|");
      if (!bySig.has(sig)) bySig.set(sig, { trips: list, dates: [], firstDate: ymd, size: list.length, count: 0 });
      const e = bySig.get(sig);
      e.dates.push(ymd);
      e.count++;
    }
    return [...bySig.values()].sort((a, b) => a.firstDate - b.firstDate);
  }, [dayList]);

  // état éditable par liste : jours cochés + nom
  // labels partagés : chaque ligne du tableau affecte UN label
  const [labels, setLabels] = React.useState(() => {
    const arr = [], seen = new Set();
    distinct.forEach(d => {
      const s = suggestNaming(d.dates, zone);
      if (!seen.has(s.name)) { seen.add(s.name); arr.push(s.name); }
    });
    return arr;
  });
  const [newLabelFor, setNewLabelFor] = React.useState(null);
  const [newLabelText, setNewLabelText] = React.useState("");
  const addLabel = (rowIdx) => {
    const name = newLabelText.trim();
    if (!name) { setNewLabelFor(null); return; }
    let idx = labels.indexOf(name);
    if (idx === -1) { setLabels(prev => [...prev, name]); idx = labels.length; }
    setRow(rowIdx, { labelId: idx });
    setNewLabelFor(null); setNewLabelText("");
  };

  const [rows, setRows] = React.useState(() =>
    distinct.map(d => {
      const sug = suggestNaming(d.dates, zone);
      return { checked: new Set(sug.pattern), labelId: Math.max(0, labels.indexOf(sug.name)), showTrips: false, showCal: false };
    })
  );
  const setRow = (i, patch) => setRows(prev => prev.map((r, k) => k === i ? { ...r, ...patch } : r));
  const toggleDay = (i, day) => setRows(prev => prev.map((r, k) => {
    if (k !== i) return r;
    const next = new Set(r.checked);
    if (next.has(day)) next.delete(day); else next.add(day);
    return { ...r, checked: next };
  }));
  // dates actives par liste, en Set pour un accès rapide
  const datesSets = distinct.map(d => new Set(d.dates));

  // Mini-mois du calendrier scolaire avec les dates actives de la liste encadrées en vert
  const RowMonth = ({ yy, mm, datesSet }) => {
    const first = new Date(yy, mm, 1);
    const mEnd = new Date(yy, mm + 1, 0).getDate();
    const monthStart = yy * 10000 + (mm + 1) * 100 + 1;
    const monthEnd = yy * 10000 + (mm + 1) * 100 + mEnd;
    const offset = (first.getDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < offset; i++) cells.push(null);
    for (let d = 1; d <= mEnd; d++) {
      const ymd = monthStart + d - 1;
      const st = schoolDayStatus(ymd, zone);
      const active = datesSet.has(ymd);
      const we = (new Date(yy, mm, d)).getDay();
      cells.push({ ymd, d, st: st === "scolaire" && (we === 0 || we === 6) ? "scolaire_we" : st, active });
    }
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-2">
        <div className="text-center text-xs font-semibold text-gray-700 mb-1">{MOIS[mm]}</div>
        <div className="grid grid-cols-7 gap-[1px]">
          {JOURS.map(j => <div key={j} className="text-center text-[9px] text-gray-400">{j[0]}</div>)}
          {cells.map((c, i) => c === null ? (
            <div key={"e" + i} />
          ) : (
            <div
              key={c.ymd}
              className="h-5 flex items-center justify-center text-[10px] rounded-sm"
              style={{
                backgroundColor: c.st ? SCHOOL_STYLE[c.st].bg : "#ffffff",
                color: c.st === "ferie" ? "#fff" : c.st ? "#374151" : "#d1d5db",
                border: c.active ? "2px solid #16a34a" : "none",
                fontWeight: c.active ? 700 : 400,
              }}
            >
              {c.d}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const [validated, setValidated] = useState(null);
  const [validationError, setValidationError] = useState(null);

  // jours de semaine effectifs d'un ensemble de dates
  const weekdaySet = (dates) => {
    const s = new Set();
    for (const ymd of dates) s.add((ymdToDate(ymd).getDay() + 6) % 7);
    return s;
  };

  const doValidate = () => {
    try {
      setValidationError(null);
      const { gtfsFiles, tripsRows, calendarRows, calDatesRows } = result;
      const warnings = [];

      // --- 1. Pour chaque trip_id : les lignes (listes distinctes) où il est présent ---
      const tripRows = new Map(); // trip_id -> Set(rowIndex)
      distinct.forEach((d, ri) => {
        for (const tid of d.trips) {
          if (!tripRows.has(tid)) tripRows.set(tid, new Set());
          tripRows.get(tid).add(ri);
        }
      });

      // --- 2. Génération des service_id : fusion des labels + motif des jours en 1res lettres ---
      // trips présents dans le même ensemble de lignes => même service_id
      const services = new Map(); // key -> { name, days:Set, dates:Set, trips:[] }
      for (const [tid, rset] of tripRows) {
        const key = [...rset].sort((a, b) => a - b).join("-");
        if (!services.has(key)) {
          const idx = [...rset].sort((a, b) => a - b);
          const names = [...new Set(idx.map(ri => labels[rows[ri].labelId]))];
          const days = new Set();
          const dates = new Set();
          for (const ri of idx) {
            rows[ri].checked.forEach(dd => days.add(dd));
            distinct[ri].dates.forEach(dd => dates.add(dd));
          }
          // motif des jours de fonctionnement : 1res lettres L M M J V S D
          const dayStr = [...days].sort((a, b) => a - b).map(d => DAY_CODES[d]).join("");
          services.set(key, { name: `${names.join(" + ")} - ${dayStr}`, days, dates, trips: [] });
        }
        services.get(key).trips.push(tid);
      }
      // garde-fou : aucun jour coché => on prend les jours réels d'activité
      for (const s of services.values()) {
        if (s.days.size === 0) {
          for (const ymd of s.dates) s.days.add((ymdToDate(ymd).getDay() + 6) % 7);
          warnings.push(`Service "${s.name}" : aucun jour coché, jours réels d'activité utilisés.`);
        }
      }
      // dédoublonnage des noms de services
      const used = new Set();
      for (const s of services.values()) {
        let name = s.name || "Service", k = 2;
        while (used.has(name)) name = `${s.name}-${k++}`;
        s.name = name;
        used.add(name);
      }

      // --- 3. Remplacement dans trips.txt ---
      const serviceOfTrip = new Map();
      for (const s of services.values()) for (const tid of s.trips) serviceOfTrip.set(tid, s.name);
      const tripsHeader = tripsRows.length ? Object.keys(tripsRows[0]) : ["route_id", "service_id", "trip_id"];
      const newTrips = tripsRows.map(r => ({
        ...r,
        service_id: serviceOfTrip.get(r.trip_id) || r.service_id,
      }));
      const unmapped = tripsRows.filter(r => !serviceOfTrip.get(r.trip_id)).length;
      if (unmapped > 0) warnings.push(`${unmapped} trip(s) sans correspondance : service_id d'origine conservé.`);

      // --- 4. Nouveau calendar.txt (calendar_dates.txt laissé vide : exceptions déjà fondues en amont) ---
      const CAL_HEADERS = ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"];
      const newCalendar = [];
      const newCalDates = []; // volontairement vide : les jours fériés sont déjà intégrés aux dates d'activité
      const activeServices = new Set();
      for (const s of services.values()) {
        if (s.dates.size === 0) continue;
        const arr = [...s.dates].sort((a, b) => a - b);
        const start = arr[0], end = arr[arr.length - 1];
        const pattern = [0, 1, 2, 3, 4, 5, 6].map(wd => s.days.has(wd) ? "1" : "0");
        newCalendar.push({
          service_id: s.name,
          monday: pattern[0], tuesday: pattern[1], wednesday: pattern[2], thursday: pattern[3],
          friday: pattern[4], saturday: pattern[5], sunday: pattern[6],
          start_date: intToYmd(start), end_date: intToYmd(end),
        });
        activeServices.add(s.name);
      }
      // intégrité : chaque trip doit référencer un service défini
      const missing = [...new Set(newTrips.map(t => t.service_id).filter(sid => !activeServices.has(sid)))];
      if (missing.length) {
        throw new Error(`Contrôle d'intégrité échoué : service_id sans définition calendar (${missing.slice(0, 3).join(", ")}…). Validation annulée.`);
      }

      // --- 5. ZIP final ---
      const calText = toCSV(CAL_HEADERS, newCalendar);
      const calDatesText = toCSV(["service_id", "date", "exception_type"], newCalDates);
      const tripsText = toCSV(tripsHeader, newTrips);
      const outFiles = { ...gtfsFiles };
      outFiles["calendar.txt"] = calText;
      outFiles["calendar_dates.txt"] = calDatesText;
      outFiles["trips.txt"] = tripsText;
      const blob = makeZip(outFiles);
      const url = URL.createObjectURL(blob);

      setValidated({
        url,
        servicesBefore: new Set([...calendarRows.map(r => r.service_id), ...calDatesRows.map(r => r.service_id)]).size,
        servicesAfter: activeServices.size,
        tripsRemapped: serviceOfTrip.size,
        tripsKept: unmapped,
        exceptions: newCalDates.length,
        warnings,
        previews: [
          { name: "calendar.txt", text: calText },
          { name: "calendar_dates.txt", text: calDatesText },
          { name: "trips.txt", text: tripsText },
        ],
      });
    } catch (e) {
      setValidationError(String(e.message || e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">Processus de nommage</h2>
        <button className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm hover:bg-gray-50" onClick={onBack}>
          ← Retour au calendrier
        </button>
      </div>
      <p className="text-sm text-gray-600">
        {distinct.length} liste(s) distincte(s) de trips détectée(s) — Zone {zone}. Les suggestions sont déduites en
        superposant les jours d'activité avec le calendrier scolaire. Vous pouvez ajuster les jours cochés et renommer chaque liste.
      </p>

      <div className="rounded-xl border bg-white border-gray-200 shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs text-gray-500 uppercase">
              <th className="p-3">Liste</th>
              <th className="p-3">Trips</th>
              <th className="p-3">Calendrier</th>
              <th className="p-3">Suggestion</th>
              <th className="p-3">Jours de fonctionnement</th>
              <th className="p-3">Nommage</th>
            </tr>
          </thead>
          <tbody>
            {distinct.map((d, i) => {
              const sug = suggestNaming(d.dates, zone);
              return (
                <React.Fragment key={i}>
                <tr className="border-b border-gray-50 align-top">
                  <td className="p-3">
                    <div className="font-medium text-gray-800">Liste {i + 1}</div>
                    <div className="text-xs text-gray-500">{d.count} jour(s) · {d.size} trip(s) · à partir du {intToYmd(d.firstDate)}</div>
                  </td>
                  <td className="p-3">
                    <button
                      className="px-2 py-1 rounded-lg border border-gray-300 text-xs hover:bg-gray-50"
                      onClick={() => setRow(i, { showTrips: !rows[i].showTrips })}
                    >
                      {rows[i].showTrips ? "Masquer" : `Voir (${d.size})`}
                    </button>
                    {rows[i].showTrips && (
                      <div className="mt-2 max-h-40 overflow-y-auto flex flex-wrap gap-1 max-w-xs">
                        {d.trips.map(tid => (
                          <span key={tid} className="text-[10px] font-mono bg-blue-50 border border-blue-200 text-blue-800 rounded px-1.5 py-0.5">{tid}</span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="p-3">
                    <button
                      className={`px-2 py-1 rounded-lg border text-xs font-medium transition-colors ${
                        rows[i].showCal ? "bg-blue-600 text-white border-blue-600" : "border-gray-300 hover:bg-gray-50"
                      }`}
                      onClick={() => setRow(i, { showCal: !rows[i].showCal })}
                    >
                      {rows[i].showCal ? "Masquer" : "Voir"}
                    </button>
                  </td>
                  <td className="p-3">
                    <span className="font-mono text-xs bg-purple-50 border border-purple-200 text-purple-800 rounded px-2 py-1">
                      {sug.name}
                    </span>
                  </td>
                  <td className="p-3">
                    <div className="flex gap-1.5">
                      {DAY_NAMES.map((dn, day) => (
                        <button
                          key={day}
                          title={dn}
                          onClick={() => toggleDay(i, day)}
                          className={`w-8 h-8 rounded-lg border text-xs font-semibold transition-colors ${
                            rows[i].checked.has(day)
                              ? "bg-blue-600 text-white border-blue-600"
                              : "bg-white text-gray-400 border-gray-300 hover:bg-gray-50"
                          }`}
                        >{DAY_CODES[day]}</button>
                      ))}
                    </div>
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-1">
                      <select
                        className="px-2 py-1 rounded-lg border border-gray-300 text-sm w-40 focus:outline-none focus:ring-2 focus:ring-purple-300"
                        value={rows[i].labelId}
                        onChange={(e) => setRow(i, { labelId: Number(e.target.value) })}
                      >
                        {labels.map((l, li) => (
                          <option key={li} value={li}>{l}</option>
                        ))}
                      </select>
                      {newLabelFor === i ? (
                        <span className="flex items-center gap-1">
                          <input
                            autoFocus
                            className="px-2 py-1 rounded-lg border border-purple-300 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-purple-300"
                            value={newLabelText}
                            placeholder="Nouveau label"
                            onChange={(e) => setNewLabelText(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") addLabel(i); }}
                          />
                          <button className="px-2 py-1 rounded-lg bg-purple-600 text-white text-xs font-semibold" onClick={() => addLabel(i)}>OK</button>
                        </span>
                      ) : (
                        <button
                          className="w-7 h-7 rounded-lg border border-gray-300 text-sm font-bold text-gray-600 hover:bg-gray-50"
                          title="Créer un nouveau label"
                          onClick={() => { setNewLabelFor(i); setNewLabelText(""); }}
                        >＋</button>
                      )}
                    </div>
                  </td>
                </tr>
                {rows[i].showCal && (
                  <tr className="border-b border-gray-50">
                    <td colSpan={6} className="p-4 bg-gray-50">
                      <div className="text-xs text-gray-500 mb-2">
                        Dates d'activité de « {labels[rows[i].labelId]} » (encadrées en vert) superposées au calendrier scolaire — Zone {zone} · {d.count} jour(s)
                      </div>
                      <div className="flex flex-col gap-3">
                        {(() => {
                          const y0 = ymdToDate(d.dates[0]).getFullYear();
                          const y1 = ymdToDate(d.dates[d.dates.length - 1]).getFullYear();
                          const years = [];
                          for (let yy = y0; yy <= y1; yy++) years.push(yy);
                          return years.map(yy => (
                            <div key={yy}>
                              <div className="text-xs font-semibold text-gray-600 mb-1">{yy}</div>
                              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                                {Array.from({ length: 12 }, (_, mm) => (
                                  <RowMonth key={mm} yy={yy} mm={mm} datesSet={datesSets[i]} />
                                ))}
                              </div>
                            </div>
                          ));
                        })()}
                      </div>
                    </td>
                  </tr>
                )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end">
        <button
          className="px-6 py-3 rounded-xl bg-green-600 text-white font-semibold hover:bg-green-700 transition-colors"
          onClick={doValidate}
        >
          Valider
        </button>
      </div>

      {validationError && (
        <div className="rounded-xl border p-4 bg-red-50 border-red-200 text-sm text-red-800">
          <div className="font-semibold mb-1">Erreur pendant la génération</div>
          {validationError}
        </div>
      )}

      {validated && (
        <div className="rounded-xl border bg-white border-gray-200 shadow-sm">
          <div className="p-4 border-b border-gray-100 font-semibold text-gray-800">
            GTFS simplifié généré
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 p-4">
            <div><div className="text-xs text-gray-500 uppercase">Services avant</div><div className="text-2xl font-bold text-gray-700">{validated.servicesBefore}</div></div>
            <div><div className="text-xs text-gray-500 uppercase">Services après</div><div className="text-2xl font-bold text-green-700">{validated.servicesAfter}</div></div>
            <div><div className="text-xs text-gray-500 uppercase">Trips renommés</div><div className="text-2xl font-bold text-blue-700">{validated.tripsRemapped}</div></div>
            <div><div className="text-xs text-gray-500 uppercase">Trips conservés</div><div className="text-2xl font-bold text-gray-700">{validated.tripsKept}</div></div>
            <div><div className="text-xs text-gray-500 uppercase">Exceptions calendar_dates</div><div className="text-2xl font-bold text-amber-600">{validated.exceptions}</div></div>
          </div>
          {validated.warnings.length > 0 && (
            <div className="mx-4 mb-4 rounded-lg border p-3 bg-amber-50 border-amber-200 text-sm text-amber-800">
              <div className="font-semibold mb-1">Avertissements</div>
              <ul className="list-disc list-inside space-y-1">
                {validated.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
          <div className="p-4 border-t border-gray-100">
            <button
              className="inline-block px-6 py-3 rounded-xl bg-blue-600 text-white font-semibold hover:bg-blue-700 transition-colors"
              onClick={() => {
                // téléchargement programmatique (fonctionne hors iframe sandboxée)
                try {
                  const a = document.createElement("a");
                  a.href = validated.url;
                  a.download = "gtfs-simplifie.zip";
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                } catch (err) {
                  setValidationError("Téléchargement direct bloqué par l'aperçu intégré : utilisez l'aperçu des fichiers ci-dessous et copiez leur contenu.");
                }
              }}
            >
              Télécharger le GTFS simplifié (.zip)
            </button>
            <div className="text-xs text-gray-500 mt-2">
              Pensez à contrôler le résultat avec un validateur GTFS (ex. gtfs-validator de MobilityData) avant toute mise en production.
            </div>
          </div>
          <div className="px-4 pb-4">
            <details className="rounded-lg border border-gray-200">
              <summary className="p-3 cursor-pointer text-sm font-medium text-gray-700">
                Aperçu des fichiers régénérés (calendar.txt, calendar_dates.txt, trips.txt)
              </summary>
              <div className="p-3 pt-0 space-y-3">
                <div className="text-xs text-gray-500">
                  Si le téléchargement ne démarre pas dans l'aperçu intégré, copiez-collez le contenu des fichiers dans des .txt de votre ZIP d'origine.
                </div>
                {validated.previews.map(p => (
                  <div key={p.name}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-semibold text-gray-600">{p.name}</span>
                      <button
                        className="px-2 py-0.5 rounded border border-gray-300 text-[10px] font-medium hover:bg-gray-100"
                        onClick={async (ev) => {
                          const btn = ev.currentTarget;
                          try {
                            await navigator.clipboard.writeText(p.text);
                            btn.textContent = "✓ Copié";
                          } catch {
                            /* repli : sélection manuelle du champ ci-dessous */
                          }
                        }}
                      > Copier</button>
                    </div>
                    <textarea
                      readOnly
                      value={p.text.length > 20000 ? p.text.slice(0, 20000) + "\n… (tronqué pour l'affichage — le téléchargement contient tout)" : p.text}
                      className="w-full h-40 text-[10px] font-mono border border-gray-200 rounded p-2 bg-gray-50"
                    />
                  </div>
                ))}
              </div>
            </details>
          </div>
        </div>
      )}
    </div>
  );
}

function ErrorList({ title, items, variant }) {
  const [open, setOpen] = useState(items.length <= 5);
  const shown = open ? items : items.slice(0, 5);
  const color = variant === "error" ? "bg-red-50 border-red-200 text-red-800" : "bg-amber-50 border-amber-200 text-amber-800";
  return (
    <div className={`rounded-xl border p-4 ${color}`}>
      <div className="font-semibold mb-2">{title} ({items.length})</div>
      <ul className="list-disc list-inside space-y-1 text-sm">
        {shown.map((e, i) => <li key={i}>{e}</li>)}
      </ul>
      {items.length > 5 && (
        <button className="mt-2 text-sm underline" onClick={() => setOpen(!open)}>
          {open ? "Réduire" : `Voir les ${items.length - 5} autres…`}
        </button>
      )}
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState("idle"); // idle | loading | error | errors | done
  const [errors, setErrors] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [result, setResult] = useState(null);
  const [fileName, setFileName] = useState("");
  const [zone, setZone] = useState("B");

  const handleFile = useCallback(async (file) => {
    setStatus("loading");
    setFileName(file.name);
    setErrors([]); setWarnings([]); setResult(null);
    try {
      const buf = await file.arrayBuffer();
      const files = await readZip(buf);
      // vérification présence des 3 fichiers
      const missing = ["calendar.txt", "calendar_dates.txt", "trips.txt"].filter(f => !files[f]);
      if (missing.length) {
        setErrors(missing.map(f => `Fichier obligatoire manquant dans le ZIP : ${f}`));
        setStatus("errors");
        return;
      }
      const v = validateGTFS(files);
      setWarnings(v.warnings || []);
      if (v.errors && v.errors.length) {
        setErrors(v.errors);
        setStatus("errors");
        return;
      }
      // --- analyse principale ---
      const serviceDates = serviceActiveDates(v.calendar, v.calDates);
      const tripsByService = {};
      for (const t of v.trips) {
        (tripsByService[t.service_id] || (tripsByService[t.service_id] = [])).push(t.trip_id);
      }
      // exceptions signalées
      const exceptionDays = new Set();
      for (const r of v.calDates) exceptionDays.add(ymdToInt(r.date));
      // bornes min / max
      let minDate = Infinity, maxDate = -Infinity;
      for (const set of Object.values(serviceDates)) {
        for (const d of set) { if (d < minDate) minDate = d; if (d > maxDate) maxDate = d; }
      }
      if (minDate === Infinity) {
        setErrors(["Aucune date active trouvée dans calendar.txt / calendar_dates.txt."]);
        setStatus("errors");
        return;
      }
      // pour chaque jour : liste de trips, puis signature
      const dayList = new Map();        // ymd -> liste triée des trip_id actifs
      const sigSet = new Set();
      const d0 = ymdToDate(minDate), d1 = ymdToDate(maxDate);
      let d = new Date(d0);
      while (d <= d1) {
        const ymd = dateToYmd(d);
        const list = [];
        for (const [sid, set] of Object.entries(serviceDates)) {
          if (set.has(ymd)) list.push(...(tripsByService[sid] || []));
        }
        list.sort();
        dayList.set(ymd, list);
        if (list.length > 0) sigSet.add(list.join("|"));
        d = new Date(d.getTime() + 86400000);
      }
      setResult({
        minDate, maxDate, dayList,
        uniqueCount: sigSet.size,
        servicesCount: new Set([...v.calendar.map(r => r.service_id), ...v.calDates.map(r => r.service_id)]).size,
        tripsCount: v.trips.length,
        exceptionDays,
        gtfsFiles: files,
        tripsRows: v.trips,
        calendarRows: v.calendar,
        calDatesRows: v.calDates,
      });
      setStatus("done");
    } catch (e) {
      setErrors([String(e.message || e)]);
      setStatus("error");
    }
  }, []);

  const spanDays = (a, b) => Math.round((b - a) / 86400000);

  return (
    <div className="min-h-screen bg-gray-100 p-6 md:p-10">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">ModifDate GTFS — Calendrier &amp; liste de trips</h1>
          <p className="text-gray-600 text-sm mt-1">
            Chargez un ZIP GTFS : l'outil vérifie les fichiers obligatoires, contrôle les anomalies bloquantes,
            affiche le calendrier global et compte le nombre de listes distinctes de trip_id par jour.
          </p>
        </div>

        {/* Zone de chargement */}
        <div
          className="rounded-2xl border-2 border-dashed border-blue-300 bg-white p-8 text-center"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
        >
          <div className="flex flex-wrap items-center justify-center gap-2 mb-5">
            <span className="text-sm text-gray-600 font-medium mr-1">Zone scolaire :</span>
            {["A", "B", "C"].map(z => (
              <button
                key={z}
                onClick={() => setZone(z)}
                className={`px-4 py-1.5 rounded-lg border text-sm font-semibold transition-colors ${
                  zone === z ? "bg-blue-600 text-white border-blue-600" : "border-gray-300 hover:bg-gray-50 text-gray-700"
                }`}
              >Zone {z}</button>
            ))}
          </div>
          <input
            id="gtfs-input"
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => { const f = e.target.files[0]; if (f) handleFile(f); }}
          />
          <label htmlFor="gtfs-input" className="cursor-pointer">
            <div className="mx-auto w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center text-2xl mb-3"> </div>
            <div className="font-semibold text-gray-800">Cliquez ou glissez-déposez votre archive GTFS (.zip)</div>
            <div className="text-xs text-gray-500 mt-1">Fichiers requis : calendar.txt, calendar_dates.txt, trips.txt</div>
          </label>
          {fileName && <div className="mt-3 text-sm text-blue-700 font-medium">{fileName}</div>}
          {status === "loading" && <div className="mt-3 text-sm text-gray-500">Analyse en cours…</div>}
        </div>

        {status === "error" && <ErrorList title="Erreur de lecture" items={errors} variant="error" />}
        {status === "errors" && (
          <div className="space-y-4">
            <ErrorList title="Anomalies bloquantes — le GTFS est refusé" items={errors} variant="error" />
            <div className="rounded-xl border p-4 bg-gray-50 border-gray-200 text-sm text-gray-600">
              Corrigez ces anomalies puis rechargez l'archive. La validation ne porte que sur les contrôles bloquants usuels
              (fichiers requis, champs obligatoires, formats de dates, service_id orphelins) — elle ne remplace pas un
              validateur complet type gtfs-validator MobilityData.
            </div>
          </div>
        )}

        {status === "done" && result && (
          <div className="space-y-4">
            {warnings.length > 0 && <ErrorList title="Avertissements (non bloquants)" items={warnings} variant="warning" />}
            <Analysis result={result} zone={zone} />
          </div>
        )}
      </div>
    </div>
  );
}