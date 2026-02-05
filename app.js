// CutLog — local-first (IndexedDB)
// Data stays in browser. Export JSON for backup.

const STATUS = document.getElementById("status");
const setStatus = (s) => { STATUS.textContent = s; };

const DB_NAME = "cutlog_db_v1";
const DB_VER = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly");
    const st = tx.objectStore("kv");
    const req = st.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(key, val) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    const st = tx.objectStore("kv");
    const req = st.put(val, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function photoPut(photoId, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("photos", "readwrite");
    const st = tx.objectStore("photos");
    const req = st.put(blob, photoId);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function photoGet(photoId) {
  if (!photoId) return null;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("photos", "readonly");
    const st = tx.objectStore("photos");
    const req = st.get(photoId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function photoDel(photoId) {
  if (!photoId) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("photos", "readwrite");
    const st = tx.objectStore("photos");
    const req = st.delete(photoId);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

function nowLocalISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function safeNum(x, fallback = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function sameDayISO(dateTimeStr, isoDate) {
  // dateTimeStr: "YYYY-MM-DDTHH:mm"
  if (!dateTimeStr) return false;
  return dateTimeStr.slice(0, 10) === isoDate;
}

function fmtK(v) {
  return Math.round(v);
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function parseCSV(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter(l => l.trim().length > 0);
  if (lines.length < 2) return { headers: [], rows: [] };

  // delimiter guess
  const first = lines[0];
  const delims = [",", "\t", ";", "|"];
  let best = ",";
  let bestCount = 0;
  for (const d of delims) {
    const c = first.split(d).length;
    if (c > bestCount) { bestCount = c; best = d; }
  }

  const splitLine = (line) => {
    // simple CSV parse: handles quoted commas minimally
    const out = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (!inQ && ch === best) { out.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  };

  const headers = splitLine(lines[0]).map(h => h.replace(/^"|"$/g, ""));
  const rows = lines.slice(1).map(l => {
    const cols = splitLine(l);
    const obj = {};
    headers.forEach((h, i) => obj[h] = cols[i] ?? "");
    return obj;
  });

  return { headers, rows, delim: best };
}

function tryParseDate(s) {
  if (!s) return null;

  // common patterns:
  // 1) ISO-like: 2026-02-03 12:34:56 or 2026/02/03 12:34
  // 2) already Date.parse ok
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t);

  // try replace / with -
  const s2 = s.replace(/\//g, "-");
  const t2 = Date.parse(s2);
  if (!Number.isNaN(t2)) return new Date(t2);

  return null;
}

function keytelKcalPerMinMale(hr, weightKg, age) {
  // Keytel 2005 male: kJ/min = -55.0969 + 0.6309*HR + 0.1988*W + 0.2017*A
  const kjMin = -55.0969 + 0.6309 * hr + 0.1988 * weightKg + 0.2017 * age;
  const kcalMin = kjMin / 4.184;
  return Math.max(0, kcalMin);
}

function keytelKcalPerMinFemale(hr, weightKg, age) {
  // Keytel 2005 female: kJ/min = -20.4022 + 0.4472*HR - 0.1263*W + 0.074*A
  const kjMin = -20.4022 + 0.4472 * hr - 0.1263 * weightKg + 0.074 * age;
  const kcalMin = kjMin / 4.184;
  return Math.max(0, kcalMin);
}

function estimateWorkoutKcalFromAvgHR({ sex, hrAvg, minutes, weightKg, age, calFactor }) {
  if (!hrAvg || !minutes || !weightKg || !age) return 0;
  const kcalMin = (sex === "female") ? keytelKcalPerMinFemale(hrAvg, weightKg, age) : keytelKcalPerMinMale(hrAvg, weightKg, age);
  return Math.max(0, Math.round(kcalMin * minutes * (calFactor || 1.0)));
}

function estimateWorkoutKcalFromSeries({ sex, series, weightKg, age, calFactor }) {
  // series: [{t: Date, hr: Number}]
  if (!series || series.length < 2 || !weightKg || !age) return { kcal: 0, minutes: 0, hrAvg: 0 };
  const sorted = [...series].filter(x => x.t instanceof Date && Number.isFinite(x.hr)).sort((a, b) => a.t - b.t);
  if (sorted.length < 2) return { kcal: 0, minutes: 0, hrAvg: 0 };

  let kcal = 0;
  let totalMin = 0;
  const hrs = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    const dtMin = (b.t - a.t) / 60000;
    if (!Number.isFinite(dtMin) || dtMin <= 0 || dtMin > 10) continue; // ignore huge gaps
    const hr = a.hr;
    const kcalMin = (sex === "female") ? keytelKcalPerMinFemale(hr, weightKg, age) : keytelKcalPerMinMale(hr, weightKg, age);
    kcal += kcalMin * dtMin;
    totalMin += dtMin;
    hrs.push(hr);
  }

  kcal = Math.max(0, Math.round(kcal * (calFactor || 1.0)));
  const hrAvg = hrs.length ? Math.round(mean(hrs)) : 0;
  const minutes = Math.round(totalMin);
  return { kcal, minutes, hrAvg };
}

function trimpBanister({ minutes, hrAvg, hrRest, hrMax, sex }) {
  // Banister TRIMP:
  // HRr = (HRavg - HRrest) / (HRmax - HRrest)
  // TRIMP = dur * HRr * 0.64 * exp(1.92*HRr) for men
  // TRIMP = dur * HRr * 0.86 * exp(1.67*HRr) for women
  if (!minutes || !hrAvg || !hrRest || !hrMax) return 0;
  const denom = (hrMax - hrRest);
  if (denom <= 0) return 0;
  const HRr = clamp((hrAvg - hrRest) / denom, 0, 1.2);
  const a = (sex === "female") ? 0.86 : 0.64;
  const b = (sex === "female") ? 1.67 : 1.92;
  const trimp = minutes * HRr * a * Math.exp(b * HRr);
  return Math.round(trimp);
}

function autoMergeMeal(m1, m2) {
  // Rule-based merge:
  // if both kcal present and within 15% -> average
  // else choose non-zero; if both present but far apart -> choose higher uncertainty default average? we choose kcal1 by default and mark uncertainty higher.
  const out = { kcal: 0, p: 0, c: 0, f: 0, unc: 0.35 };
  const has1 = safeNum(m1.kcal, 0) > 0;
  const has2 = safeNum(m2.kcal, 0) > 0;

  if (!has1 && !has2) return out;

  const pick = (a, b) => {
    const A = safeNum(a, 0), B = safeNum(b, 0);
    if (A <= 0 && B <= 0) return 0;
    if (A <= 0) return B;
    if (B <= 0) return A;
    const diff = Math.abs(A - B) / Math.max(A, B);
    if (diff <= 0.15) return (A + B) / 2;
    // far apart: do NOT average; return A (treat as primary)
    return A;
  };

  out.kcal = fmtK(pick(m1.kcal, m2.kcal));
  out.p = +pick(m1.p, m2.p).toFixed(1);
  out.c = +pick(m1.c, m2.c).toFixed(1);
  out.f = +pick(m1.f, m2.f).toFixed(1);

  // uncertainty heuristic
  if (has1 && has2) {
    const A = safeNum(m1.kcal, 0), B = safeNum(m2.kcal, 0);
    const diff = Math.abs(A - B) / Math.max(A, B);
    out.unc = clamp(0.2 + diff, 0.2, 0.95);
  } else {
    out.unc = 0.45;
  }
  return out;
}

// ----- Text-only food estimate (range) -----
// Goal: give a reasonable kcal range, not a single "exact" number.
// Strategy: point estimate + bounded relative uncertainty (avoid crazy-wide ranges).

const CN_NUM = {
  "半": 0.5, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
  "六": 6, "七": 7, "八": 8, "九": 9, "十": 10
};

function parseCNOrNumber(token) {
  if (token == null) return NaN;
  const t = String(token).trim();
  if (t in CN_NUM) return CN_NUM[t];
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
}

function boundedRange(mid, u) {
  const uu = clamp(u, 0.05, 0.60); // cap half-width to avoid 50~400 style nonsense
  const low = Math.max(0, Math.round(mid * (1 - uu)));
  const high = Math.max(low, Math.round(mid * (1 + uu)));
  return { low, high, mid: Math.round(mid), u: uu };
}

const FOOD_DB = [
  // per100g kcal are rough typical values (cooked unless stated)
  { name: "米饭", keys: ["米饭","白米饭"], per100g: 130, defaultG: 180, unit: "碗" },
  { name: "面条", keys: ["面条","面","拉面","乌冬","粉"], per100g: 140, defaultG: 260, unit: "碗" },
  { name: "鸡胸", keys: ["鸡胸","鸡胸肉"], per100g: 165, defaultG: 150, unit: "份" },
  { name: "鸡肉", keys: ["鸡肉","白斩鸡","烤鸡","炸鸡"], per100g: 210, defaultG: 150, unit: "份" },
  { name: "牛肉", keys: ["牛肉"], per100g: 250, defaultG: 150, unit: "份" },
  { name: "猪肉", keys: ["猪肉","五花肉"], per100g: 290, defaultG: 120, unit: "份" },
  { name: "鱼", keys: ["鱼","三文鱼","金枪鱼"], per100g: 200, defaultG: 160, unit: "份" },
  { name: "鸡蛋", keys: ["鸡蛋","鸡蛋羹","蛋"], kcalEach: 70, defaultEach: 1, unit: "个" },
  { name: "牛奶", keys: ["牛奶","奶"], per100ml: 60, defaultML: 250, unit: "杯" },
  { name: "酸奶", keys: ["酸奶","优格","yogurt"], per100g: 90, defaultG: 150, unit: "杯" },
  { name: "面包", keys: ["面包","吐司"], kcalEach: 80, defaultEach: 1, unit: "片" },
  { name: "香蕉", keys: ["香蕉"], kcalEach: 105, defaultEach: 1, unit: "根" },
  { name: "苹果", keys: ["苹果"], kcalEach: 95, defaultEach: 1, unit: "个" },
  { name: "饺子", keys: ["饺子"], kcalEach: 40, defaultEach: 10, unit: "个" },
  { name: "方便面", keys: ["方便面","泡面"], kcalEach: 450, defaultEach: 1, unit: "包" },
  { name: "薯条", keys: ["薯条"], per100g: 310, defaultG: 120, unit: "份" },
  { name: "青菜", keys: ["青菜","蔬菜","西兰花","生菜","白菜"], per100g: 25, defaultG: 200, unit: "份" }
];

function applyCookingMultiplier(text, kcal) {
  const t = text;
  let mult = 1.0;
  if (t.includes("油炸") || t.includes("炸")) mult *= 1.25;
  if (t.includes("煎")) mult *= 1.15;
  if (t.includes("炒")) mult *= 1.12;
  if (t.includes("红烧") || t.includes("酱") || t.includes("糖醋")) mult *= 1.10;
  if (t.includes("奶油") || t.includes("芝士") || t.includes("起司")) mult *= 1.12;
  return kcal * mult;
}

function inferPortionSize(text) {
  // affects default grams/ml
  let mult = 1.0;
  if (text.includes("大")) mult *= 1.20;
  if (text.includes("小")) mult *= 0.85;
  if (text.includes("半")) mult *= 0.60; // if only "半" without explicit unit, be conservative
  return mult;
}

function matchQuantityNear(text, key) {
  // returns { grams, ml, count, unit, explicitness }
  // explicitness: "kcal" | "g" | "count" | "default"
  const t = text;

  // kcal directly mentioned
  let m = t.match(/(\d+(?:\.\d+)?)\s*(kcal|千卡|卡)\b/i);
  if (m) return { kcal: parseFloat(m[1]), explicitness: "kcal" };

  // grams (near key)
  const rg1 = new RegExp(`${key}\\s*(\\d+(?:\\.\\d+)?)\\s*(g|克)`);
  const rg2 = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(g|克)\\s*${key}`);
  m = t.match(rg1) || t.match(rg2);
  if (m) return { grams: parseFloat(m[1]), explicitness: "g" };

  // ml
  const rm1 = new RegExp(`${key}\\s*(\\d+(?:\\.\\d+)?)\\s*(ml|毫升)`, "i");
  const rm2 = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(ml|毫升)\\s*${key}`, "i");
  m = t.match(rm1) || t.match(rm2);
  if (m) return { ml: parseFloat(m[1]), explicitness: "ml" };

  // count + unit near key
  const units = ["碗","个","颗","片","杯","包","盒","盘","勺","根","份"];
  const unitRe = units.join("|");
  const rn1 = new RegExp(`(半|一|二|两|三|四|五|\\d+(?:\\.\\d+)?)\\s*(${unitRe})\\s*${key}`);
  const rn2 = new RegExp(`${key}\\s*(半|一|二|两|三|四|五|\\d+(?:\\.\\d+)?)\\s*(${unitRe})`);
  m = t.match(rn1) || t.match(rn2);
  if (m) {
    const count = parseCNOrNumber(m[1]);
    const unit = m[2];
    if (Number.isFinite(count)) return { count, unit, explicitness: "count" };
  }

  return { explicitness: "default" };
}

function estimateKcalRangeFromText(textRaw) {
  const text = (textRaw || "").toLowerCase();
  if (!text.trim()) return { ok: false, reason: "empty" };

  // if user already typed kcal in text, treat as narrow range
  const kcalDirect = text.match(/(\d+(?:\.\d+)?)\s*(kcal|千卡|卡)\b/i);
  if (kcalDirect) {
    const mid = parseFloat(kcalDirect[1]);
    const r = boundedRange(mid, 0.05);
    return {
      ok: true,
      range: r,
      uncSuggested: 0.10,
      explanation: `检测到你在文字里直接给了热量：${r.mid} kcal（按±5%给范围）`,
      followups: ""
    };
  }

  const portionMult = inferPortionSize(text);
  const matched = [];

  for (const item of FOOD_DB) {
    let hit = false;
    let usedKey = "";
    for (const k of item.keys) {
      if (text.includes(k.toLowerCase())) { hit = true; usedKey = k; break; }
    }
    if (!hit) continue;

    const q = matchQuantityNear(text, usedKey.toLowerCase());
    let mid = 0;
    let u = 0.30; // default
    let detail = "";

    if (q.explicitness === "kcal" && q.kcal) {
      mid = q.kcal;
      u = 0.05;
      detail = `直接给kcal`;
    } else if (q.explicitness === "g" && q.grams) {
      if (item.per100g) {
        mid = (q.grams * item.per100g) / 100;
        u = 0.08;
        detail = `${q.grams}g`;
      } else {
        // fallback: each-based items with grams unknown
        mid = item.kcalEach ? item.kcalEach * (q.grams / 50) : 0;
        u = 0.20;
        detail = `${q.grams}g(粗略)`;
      }
    } else if (q.explicitness === "ml" && q.ml) {
      if (item.per100ml) {
        mid = (q.ml * item.per100ml) / 100;
        u = 0.08;
        detail = `${q.ml}ml`;
      } else {
        mid = 0;
      }
    } else if (q.explicitness === "count" && q.count) {
      const count = q.count;
      const unit = q.unit || item.unit || "份";
      if (item.kcalEach) {
        mid = item.kcalEach * count;
        u = 0.12;
        detail = `${count}${unit}`;
      } else if (item.per100g && item.defaultG) {
        let g = item.defaultG * count;
        // if unit is bowl/plate/cup, use defaults; else still use defaultG
        g *= portionMult;
        mid = (g * item.per100g) / 100;
        u = (unit === "碗" || unit === "盘" || unit === "杯") ? 0.22 : 0.18;
        detail = `${count}${unit}(按默认分量)`;
      } else {
        mid = 0;
      }
    } else { // default portion
      if (item.kcalEach) {
        mid = item.kcalEach * (item.defaultEach || 1);
        u = 0.20;
        detail = `默认${item.defaultEach || 1}${item.unit || "份"}`;
      } else if (item.per100g && item.defaultG) {
        const g = item.defaultG * portionMult;
        mid = (g * item.per100g) / 100;
        u = 0.28;
        detail = `默认${item.unit || "份"}`;
      } else if (item.per100ml && item.defaultML) {
        const ml = item.defaultML * portionMult;
        mid = (ml * item.per100ml) / 100;
        u = 0.22;
        detail = `默认${item.unit || "杯"}`;
      }
    }

    if (mid > 0) {
      // cooking style multiplier
      mid = applyCookingMultiplier(text, mid);
      // range per item
      const r = boundedRange(mid, u);
      matched.push({ name: item.name, key: usedKey, detail, ...r });
    }
  }

  if (!matched.length) {
    // unknown: use user's own guess if any number exists (like "一碗" no food)
    const num = text.match(/(\d+(?:\.\d+)?)/);
    if (num) {
      const guess = parseFloat(num[1]);
      const r = boundedRange(guess, 0.35);
      return {
        ok: true,
        range: r,
        uncSuggested: 0.35,
        explanation: `未识别到常见食物关键词，先按你文字里的数字 ${guess} 做粗略范围（建议补充“食物名+克重/份量”）`,
        followups: "建议写法：米饭 1碗(或180g) / 鸡肉 150g / 用油 1勺(10g)"
      };
    }
    return { ok: false, reason: "no_match" };
  }

  // Sum ranges (add lows/highs)
  const low = matched.reduce((s, x) => s + x.low, 0);
  const high = matched.reduce((s, x) => s + x.high, 0);
  const mid = Math.round((low + high) / 2);

  // suggest uncertainty as relative half-width of total range
  const uTot = clamp((high - low) / Math.max(1, (high + low) / 2) / 2, 0.10, 0.45);

  const parts = matched.map(x => `${x.name}(${x.detail}): ${x.low}–${x.high}`).join("；");
  const followups = "更窄范围的关键：克重/份量（碗/盘/个）+ 用油/酱料（勺/克）+ 吃了多少比例（例如 70%）。";
  return {
    ok: true,
    range: { low, high, mid, u: uTot },
    uncSuggested: +uTot.toFixed(2),
    explanation: `识别并估算：${parts}`,
    followups
  };
}

function setKcalRangeFields(low, high) {
  const lo = Math.max(0, Math.round(safeNum(low, 0)));
  const hi = Math.max(lo, Math.round(safeNum(high, 0)));
  const elLo = document.getElementById("kcalLow");
  const elHi = document.getElementById("kcalHigh");
  if (elLo) elLo.value = lo ? lo : "";
  if (elHi) elHi.value = hi ? hi : "";
}

function setKcalRangeFromFinal(kcal, unc) {
  const mid = safeNum(kcal, 0);
  if (!mid) return;
  const u = clamp(safeNum(unc, 0.25), 0.05, 0.60);
  const r = boundedRange(mid, u);
  setKcalRangeFields(r.low, r.high);
}

// ----- end text estimate -----

function getMealKcalRange(m) {
  if (m && m.finalRange && m.finalRange.kcalLow && m.finalRange.kcalHigh) {
    const lo = Math.max(0, Math.round(safeNum(m.finalRange.kcalLow, 0)));
    const hi = Math.max(lo, Math.round(safeNum(m.finalRange.kcalHigh, 0)));
    return { low: lo, high: hi, mid: Math.round((lo + hi) / 2) };
  }
  const kcal = safeNum(m?.final?.kcal, 0);
  const u = clamp(safeNum(m?.unc, 0.35), 0.05, 0.60);
  const r = boundedRange(kcal, u);
  return { low: r.low, high: r.high, mid: r.mid };
}



function blobToObjectURL(blob) {
  if (!blob) return "";
  return URL.createObjectURL(blob);
}

async function compressImageToBlob(file, maxW = 1280, quality = 0.78) {
  // compress into JPEG blob to reduce storage
  return new Promise((resolve) => {
    if (!file) return resolve(null);
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        resolve(blob);
      }, "image/jpeg", quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

// State
let state = null;

function defaultState() {
  return {
    profile: { age: 21, sex: "male", weightKg: "", hrRest: "", hrMax: "", calFactor: 1.0, kcalTarget: "", budgetMode: "mid" },
    meals: [],
    workouts: [],
    weights: [] // {date:"YYYY-MM-DD", kg:number}
  };
}

async function loadState() {
  const saved = await dbGet("state");
  if (saved && typeof saved === "object") return saved;
  return defaultState();
}

async function saveState() {
  await dbSet("state", state);
}

function getProfileComputed() {
  const age = safeNum(state.profile.age, 21);
  const sex = state.profile.sex || "male";
  const weightKg = safeNum(state.profile.weightKg, 0);
  const hrRest = safeNum(state.profile.hrRest, 0);
  const hrMax = safeNum(state.profile.hrMax, 0) || (220 - age);
  const calFactor = safeNum(state.profile.calFactor, 1.0);
  return { age, sex, weightKg, hrRest, hrMax, calFactor };
}

// Tabs
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("view-" + btn.dataset.tab).classList.add("active");
    renderAll();
  });
});

// Inputs
const mealTime = document.getElementById("mealTime");
const woTime = document.getElementById("woTime");
mealTime.value = nowLocalISO();
woTime.value = nowLocalISO();
// Meals: auto estimate from text (no extra button), and stop overwriting after manual edits.
let mealManual = false;
function mealFieldsAllEmpty() {
  const ids = ["kcalFinal","kcalLow","kcalHigh","mealUnc"];
  return ids.every(id => ((document.getElementById(id)?.value || "").trim().length === 0));
}
function maybeAutoEstimateMeal() {
  if (mealManual) return;
  const name = (document.getElementById("mealName").value || "").trim();
  const note = (document.getElementById("mealNote").value || "").trim();
  const res = estimateKcalRangeFromText(`${name} ${note}`);
  const sug = document.getElementById("mealTextSuggestions");
  if (!res || !res.ok) return;

  setKcalRangeFields(res.range.low, res.range.high);
  document.getElementById("kcalFinal").value = res.range.mid || "";
  document.getElementById("mealUnc").value = (+((res.uncSuggested ?? res.range.u ?? 0.25).toFixed(2)));

  if (sug) {
    const extra = res.followups ? ("  " + res.followups) : "";
    sug.textContent = (res.explanation || "") + extra;
  }
  setStatus("已自动估算范围（可手改）");
}

// manual override detection: once user types in result fields, stop auto until cleared
["kcalFinal","kcalLow","kcalHigh","mealUnc"].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", () => {
    if (mealFieldsAllEmpty()) {
      mealManual = false;
      maybeAutoEstimateMeal();
      return;
    }
    mealManual = true;
  });
});

["mealName","mealNote"].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", () => {
    if (!mealManual) maybeAutoEstimateMeal();
  });
});

// Weight log
document.getElementById("wDate").value = todayISO();

document.getElementById("addWeight").addEventListener("click", async () => {
  const date = document.getElementById("wDate").value || todayISO();
  const kg = safeNum(document.getElementById("wKg").value, 0);
  if (!kg) return setStatus("体重未填写");

  // upsert by date
  state.weights = state.weights.filter(w => w.date !== date);
  state.weights.unshift({ date, kg: +kg.toFixed(1) });
  state.weights.sort((a,b) => b.date.localeCompare(a.date));
  await saveState();
  setStatus("体重已记录");
  renderAll();
});

// Profile
function fillProfileUI() {
  document.getElementById("age").value = safeNum(state.profile.age, 21);
  document.getElementById("sex").value = state.profile.sex || "male";
  document.getElementById("weight").value = state.profile.weightKg;
  document.getElementById("hrrest").value = state.profile.hrRest;
  document.getElementById("hrmax").value = state.profile.hrMax;
  document.getElementById("calFactor").value = safeNum(state.profile.calFactor, 1.0).toFixed(2);
  document.getElementById("kcalTarget").value = state.profile.kcalTarget;
  document.getElementById("budgetMode").value = state.profile.budgetMode || "mid";
}

document.getElementById("saveProfile").addEventListener("click", async () => {
  state.profile.age = safeNum(document.getElementById("age").value, 21);
  state.profile.sex = document.getElementById("sex").value || "male";
  state.profile.weightKg = document.getElementById("weight").value;
  state.profile.hrRest = document.getElementById("hrrest").value;
  state.profile.hrMax = document.getElementById("hrmax").value;
  state.profile.calFactor = safeNum(document.getElementById("calFactor").value, 1.0);

  await saveState();
  setStatus("个人信息已保存");
  renderAll();
});

document.getElementById("resetProfile").addEventListener("click", async () => {
  state.profile = defaultState().profile;
  await saveState();
  fillProfileUI();
  setStatus("已重置个人信息");
  renderAll();
});

// Meals
// text-only estimate -> fill kcal range (low-high) + mid
document.getElementById("addMeal").addEventListener("click", async () => {
  const time = mealTime.value || nowLocalISO();
  const type = document.getElementById("mealType").value || "餐";
  const name = document.getElementById("mealName").value.trim();
  const note = document.getElementById("mealNote").value.trim();

  // prefer range fields; kcalFinal is treated as "mid"
  const final = { kcal: safeNum(document.getElementById("kcalFinal").value, 0) };
  let unc = clamp(safeNum(document.getElementById("mealUnc").value, 0.35), 0, 1);

  const kcalLowIn = safeNum(document.getElementById("kcalLow").value, 0);
  const kcalHighIn = safeNum(document.getElementById("kcalHigh").value, 0);
  let finalRange = null;

  if (kcalLowIn && kcalHighIn && kcalHighIn >= kcalLowIn) {
    finalRange = { kcalLow: Math.round(kcalLowIn), kcalHigh: Math.round(kcalHighIn) };
    if (!final.kcal) final.kcal = Math.round((finalRange.kcalLow + finalRange.kcalHigh) / 2);
  }

  // If user didn't fill numbers, try text estimate once before saving (no extra button)
  if ((!final.kcal || !finalRange) && (name || note)) {
    const res = estimateKcalRangeFromText(`${name} ${note}`);
    if (res && res.ok) {
      if (!finalRange) finalRange = { kcalLow: res.range.low, kcalHigh: res.range.high };
      if (!final.kcal) final.kcal = res.range.mid || Math.round((finalRange.kcalLow + finalRange.kcalHigh) / 2);
      if (!document.getElementById("mealUnc").value) unc = clamp(res.uncSuggested ?? unc, 0, 1);
      // also sync UI if not manual
      if (!mealManual) {
        setKcalRangeFields(finalRange.kcalLow, finalRange.kcalHigh);
        document.getElementById("kcalFinal").value = final.kcal || "";
        document.getElementById("mealUnc").value = (+unc.toFixed(2));
      }
    }
  }

  // derive range from mid + unc if still missing
  if (!finalRange && final.kcal) {
    const r = boundedRange(final.kcal, clamp(unc, 0.05, 0.60));
    finalRange = { kcalLow: r.low, kcalHigh: r.high };
  }

  if (!final.kcal && !finalRange) {
    setStatus("请至少写一点描述（或手动填写 kcal 范围/中值）");
    return;
  }

  // photo
  const file = document.getElementById("mealPhoto").files[0];
  let photoId = "";
  if (file) {
    const blob = await compressImageToBlob(file);
    if (blob) {
      photoId = uid();
      await photoPut(photoId, blob);
    }
  }

  const meal = {
    id: uid(),
    time, type, name,
    final,
    finalRange,
    unc,
    note,
    photoId
  };

  state.meals.unshift(meal);
  await saveState();

  clearMealForm(false);
  setStatus("已添加一餐");
  renderAll();
});

function clearMealForm(alsoTime = false) {
  if (alsoTime) mealTime.value = nowLocalISO();
  document.getElementById("mealType").value = "早餐";
  document.getElementById("mealName").value = "";
  ["kcalFinal","kcalLow","kcalHigh"].forEach(id => document.getElementById(id).value = "");
  mealManual = false;
  document.getElementById("mealUnc").value = "0.35";
  const sug = document.getElementById("mealTextSuggestions");
  if (sug) sug.textContent = "";

  document.getElementById("mealPhoto").value = "";
  document.getElementById("mealNote").value = "";
}

document.getElementById("clearMealForm").addEventListener("click", () => {
  clearMealForm(true);
  setStatus("已清空表单");
});

// Workouts (manual)
document.getElementById("addWorkoutManual").addEventListener("click", async () => {
  const time = woTime.value || nowLocalISO();
  const type = document.getElementById("woType").value.trim() || "训练";
  const minutes = safeNum(document.getElementById("woDur").value, 0);
  const hrAvg = safeNum(document.getElementById("woHr").value, 0);
  const rpe = document.getElementById("woRpe").value ? safeNum(document.getElementById("woRpe").value, 0) : "";
  const note = document.getElementById("woNote").value.trim();

  const { age, sex, weightKg, hrRest, hrMax, calFactor } = getProfileComputed();
  if (!weightKg) return setStatus("请先在“个人”里填体重（kg）");
  if (!minutes) return setStatus("请填写时长（分钟）");
  if (!hrAvg) return setStatus("请填写平均心率（bpm）");

  const kcal = estimateWorkoutKcalFromAvgHR({ sex, hrAvg, minutes, weightKg, age, calFactor });
  const trimp = trimpBanister({ minutes, hrAvg, hrRest: hrRest || 0, hrMax: hrMax || (220-age), sex });

  state.workouts.unshift({
    id: uid(),
    time, type,
    minutes,
    hrAvg,
    kcal,
    trimp: trimp || "",
    source: "manual",
    note
  });

  await saveState();
  clearWorkoutForm(false);
  setStatus("已添加训练");
  renderAll();
});

function clearWorkoutForm(alsoTime = false) {
  if (alsoTime) woTime.value = nowLocalISO();
  document.getElementById("woType").value = "";
  document.getElementById("woDur").value = "";
  document.getElementById("woHr").value = "";
  document.getElementById("woRpe").value = "";
  document.getElementById("woNote").value = "";
}
document.getElementById("clearWoForm").addEventListener("click", () => { clearWorkoutForm(true); setStatus("已清空表单"); });

// CSV import
let csvCache = null;

document.getElementById("importHrCsv").addEventListener("click", async () => {
  const f = document.getElementById("hrCsv").files[0];
  if (!f) return setStatus("请选择 CSV 文件");
  const txt = await f.text();
  const parsed = parseCSV(txt);
  if (!parsed.headers.length) return setStatus("CSV 解析失败（文件内容不足）");

  csvCache = parsed;
  const mapper = document.getElementById("csvMapper");
  mapper.classList.remove("hidden");

  const colTime = document.getElementById("colTime");
  const colHr = document.getElementById("colHr");
  colTime.innerHTML = "";
  colHr.innerHTML = "";

  parsed.headers.forEach(h => {
    const opt1 = document.createElement("option"); opt1.value = h; opt1.textContent = h;
    const opt2 = document.createElement("option"); opt2.value = h; opt2.textContent = h;
    colTime.appendChild(opt1);
    colHr.appendChild(opt2);
  });

  // best-effort auto-select
  const lower = parsed.headers.map(h => h.toLowerCase());
  const pickByKeys = (keys) => {
    for (const k of keys) {
      const idx = lower.findIndex(h => h.includes(k));
      if (idx >= 0) return parsed.headers[idx];
    }
    return parsed.headers[0];
  };
  colTime.value = pickByKeys(["time","date","timestamp","开始","时间","datetime"]);
  colHr.value = pickByKeys(["hr","heart","心率","bpm"]);

  // preview first 8 rows
  const previewRows = parsed.rows.slice(0, 8);
  const cols = parsed.headers.slice(0, Math.min(6, parsed.headers.length));
  const lines = [];
  lines.push(`Delimiter: ${parsed.delim}`);
  lines.push(cols.join(" | "));
  lines.push("-".repeat(60));
  previewRows.forEach(r => {
    lines.push(cols.map(c => (r[c] ?? "")).join(" | "));
  });
  document.getElementById("csvPreview").textContent = lines.join("\n");

  setStatus("已读取 CSV，请选择时间列和心率列");
});

document.getElementById("cancelImportCsv").addEventListener("click", () => {
  csvCache = null;
  document.getElementById("csvMapper").classList.add("hidden");
  setStatus("已取消导入");
});

document.getElementById("confirmImportCsv").addEventListener("click", async () => {
  if (!csvCache) return;
  const colTime = document.getElementById("colTime").value;
  const colHr = document.getElementById("colHr").value;
  const type = document.getElementById("csvWoType").value.trim() || "训练";
  const note = document.getElementById("csvWoNote").value.trim();

  const { age, sex, weightKg, hrRest, hrMax, calFactor } = getProfileComputed();
  if (!weightKg) return setStatus("请先在“个人”里填体重（kg）");

  const series = [];
  for (const r of csvCache.rows) {
    const t = tryParseDate(r[colTime]);
    const hr = safeNum(r[colHr], NaN);
    if (t && Number.isFinite(hr)) series.push({ t, hr });
  }
  if (series.length < 2) return setStatus("导入失败：有效心率点不足（检查列映射）");

  const est = estimateWorkoutKcalFromSeries({ sex, series, weightKg, age, calFactor });
  const hrAvg = est.hrAvg;
  const minutes = est.minutes;
  const kcal = est.kcal;
  const trimp = trimpBanister({ minutes, hrAvg, hrRest: hrRest || 0, hrMax: hrMax || (220-age), sex });

  // choose time as first point local
  const sorted = series.sort((a,b)=>a.t-b.t);
  const start = new Date(sorted[0].t);
  start.setMinutes(start.getMinutes() - start.getTimezoneOffset());
  const time = start.toISOString().slice(0,16);

  state.workouts.unshift({
    id: uid(),
    time,
    type,
    minutes,
    hrAvg,
    kcal,
    trimp: trimp || "",
    source: "csv",
    note: note ? `${note} (from CSV)` : "from CSV"
  });

  await saveState();
  csvCache = null;
  document.getElementById("csvMapper").classList.add("hidden");
  document.getElementById("hrCsv").value = "";
  document.getElementById("csvWoType").value = "";
  document.getElementById("csvWoNote").value = "";
  setStatus("已从 CSV 生成训练记录");
  renderAll();
});

// Backup
document.getElementById("exportBtn").addEventListener("click", async () => {
  await exportJSON(true);
});
document.getElementById("exportNoPhotosBtn").addEventListener("click", async () => {
  await exportJSON(false);
});
document.getElementById("importBtn").addEventListener("click", async () => {
  const f = document.getElementById("importFile").files[0];
  if (!f) return setStatus("请选择 JSON 文件");
  const txt = await f.text();
  try {
    const obj = JSON.parse(txt);
    if (!obj || !obj.profile || !Array.isArray(obj.meals) || !Array.isArray(obj.workouts)) throw new Error("bad");
    // photos
    if (obj.__photos && typeof obj.__photos === "object") {
      setStatus("正在恢复照片…");
      for (const [photoId, dataUrl] of Object.entries(obj.__photos)) {
        const blob = await (await fetch(dataUrl)).blob();
        await photoPut(photoId, blob);
      }
      delete obj.__photos;
    }
    state = obj;
    await saveState();
    fillProfileUI();
    setStatus("导入完成");
    renderAll();
  } catch {
    setStatus("导入失败：文件格式不正确");
  }
});

document.getElementById("wipeBtn").addEventListener("click", async () => {
  if (!confirm("确定清空本地数据？此操作不可恢复（除非你有备份）。")) return;
  state = defaultState();
  await saveState();
  setStatus("已清空");
  renderAll();
});

async function exportJSON(withPhotos) {
  const out = structuredClone(state);
  if (withPhotos) {
    // embed photos as data URLs (can be large)
    const photos = {};
    for (const m of out.meals) {
      if (!m.photoId) continue;
      const blob = await photoGet(m.photoId);
      if (!blob) continue;
      const dataUrl = await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.readAsDataURL(blob);
      });
      photos[m.photoId] = dataUrl;
    }
    out.__photos = photos;
  }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = withPhotos ? "cutlog-backup-with-photos.json" : "cutlog-backup.json";
  a.click();
  URL.revokeObjectURL(url);
  setStatus(withPhotos ? "已导出（含照片）" : "已导出（不含照片）");
}

// Rendering
async function renderAll() {
  await renderDash();
  await renderWeights();
  await renderMeals();
  await renderWorkouts();
  fillProfileUI();
}

async function renderDash() {
  const today = todayISO();
  const meals = state.meals.filter(m => sameDayISO(m.time, today));
  const wos = state.workouts.filter(w => sameDayISO(w.time, today));

  // Intake range sums
  let inMid = 0, inLow = 0, inHigh = 0;
  for (const m of meals) {
    const rr = getMealKcalRange(m);
    inMid += safeNum(rr.mid, 0);
    inLow += safeNum(rr.low, 0);
    inHigh += safeNum(rr.high, 0);
  }
  const outK = wos.reduce((s, w) => s + safeNum(w.kcal, 0), 0);

  const { kcalTarget, budgetMode } = getProfileComputed();
  const basisIn = (budgetMode === "high") ? inHigh : inMid;
  const remaining = kcalTarget ? Math.round(kcalTarget - basisIn) : null;

  const targetLine = kcalTarget
    ? `<div>目标 Target: <span class="accent">${Math.round(kcalTarget)}</span> kcal · 口径 ${budgetMode === "high" ? "上限" : "中值"}</div>`
    : `<div class="muted">可在「个人」里设置每日目标（可选）</div>`;

  const remainingLine = (kcalTarget !== 0 && remaining !== null)
    ? `<div>剩余 Remaining: <span class="accent">${remaining}</span> kcal</div>`
    : ``;

  document.getElementById("todaySummary").innerHTML = `
    ${targetLine}
    <div>摄入 In: <span class="accent">${Math.round(inLow)}–${Math.round(inHigh)}</span> kcal (mid ${Math.round(inMid)})</div>
    <div>训练 Out(est): <span class="accent">${Math.round(outK)}</span> kcal</div>
    <div>净值 Net(mid): <span class="accent">${Math.round(inMid - outK)}</span> kcal</div>
    ${remainingLine}
  `;

  const boxes = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    const iso = d.toISOString().slice(0, 10);

    const dayMeals = state.meals.filter(m => sameDayISO(m.time, iso));
    const dayWos = state.workouts.filter(w => sameDayISO(w.time, iso));

    let dayMid = 0, dayLow = 0, dayHigh = 0;
    for (const m of dayMeals) {
      const rr = getMealKcalRange(m);
      dayMid += safeNum(rr.mid, 0);
      dayLow += safeNum(rr.low, 0);
      dayHigh += safeNum(rr.high, 0);
    }

    const outK = dayWos.reduce((s, w) => s + safeNum(w.kcal, 0), 0);
    boxes.push({ iso, dayLow, dayHigh, dayMid, outK, net: dayMid - outK });
  }

  const weekEl = document.getElementById("weekSummary");
  weekEl.innerHTML = "";
  boxes.reverse().forEach(b => {
    const div = document.createElement("div");
    div.className = "dayBox";
    div.innerHTML = `
      <div class="d">${b.iso.slice(5)}</div>
      <div class="k">In ${Math.round(b.dayLow)}–${Math.round(b.dayHigh)} (mid ${Math.round(b.dayMid)})</div>
      <div class="k">Out ${Math.round(b.outK)} · Net(mid) ${Math.round(b.net)}</div>
    `;
    weekEl.appendChild(div);
  });
}

async function renderWeights() {
  const box = document.getElementById("weightList");
  box.innerHTML = "";
  state.weights.slice(0, 8).forEach(w => {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="itemHead">
        <div>
          <div class="itemTitle">${w.date}</div>
          <div class="itemMeta">${w.kg} kg</div>
        </div>
        <div class="itemActions">
          <button class="smallBtn" data-delw="${w.date}">删除</button>
        </div>
      </div>
    `;
    box.appendChild(div);
  });
  box.querySelectorAll("[data-delw]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const date = btn.getAttribute("data-delw");
      state.weights = state.weights.filter(x => x.date !== date);
      await saveState();
      setStatus("已删除体重记录");
      renderAll();
    });
  });
}

async function renderMeals() {
  const box = document.getElementById("mealList");
  box.innerHTML = "";
  const items = state.meals.slice(0, 20);
  for (const m of items) {
    const div = document.createElement("div");
    div.className = "item";

    let imgHtml = "";
    if (m.photoId) {
      const blob = await photoGet(m.photoId);
      if (blob) {
        const url = blobToObjectURL(blob);
        imgHtml = `<img class="thumb" src="${url}" alt="meal photo">`;
        // revoke later
        setTimeout(() => URL.revokeObjectURL(url), 20000);
      }
    }
    const f = m.final || {};
    const rr = (m.finalRange && m.finalRange.kcalLow && m.finalRange.kcalHigh)
      ? { low: Math.round(m.finalRange.kcalLow), high: Math.round(m.finalRange.kcalHigh), mid: Math.round((m.finalRange.kcalLow + m.finalRange.kcalHigh) / 2) }
      : boundedRange(safeNum(f.kcal,0), clamp(safeNum(m.unc,0.35), 0.05, 0.60));
    div.innerHTML = `
      <div class="itemHead">
        <div>
          <div class="itemTitle">${escapeHtml(m.type)} · ${escapeHtml(m.time.replace("T"," "))}</div>
          <div class="itemMeta">${escapeHtml(m.name || "(未命名)")}</div>
          <div class="itemMeta">kcal: ${fmtK(rr.low)}–${fmtK(rr.high)} (mid ${fmtK(rr.mid)}) · 不确定性 ${safeNum(m.unc,0.35).toFixed(2)}</div>
          ${m.note ? `<div class="itemMeta">${escapeHtml(m.note)}</div>` : ``}
        </div>
        <div class="itemActions">
          <button class="smallBtn" data-editm="${m.id}">编辑</button>
          <button class="smallBtn" data-delm="${m.id}">删除</button>
        </div>
      </div>
      ${imgHtml}
    `;

    box.appendChild(div);
  }

  box.querySelectorAll("[data-delm]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-delm");
      const m = state.meals.find(x => x.id === id);
      if (m?.photoId) await photoDel(m.photoId);
      state.meals = state.meals.filter(x => x.id !== id);
      await saveState();
      setStatus("已删除一餐");
      renderAll();
    });
  });

  box.querySelectorAll("[data-editm]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-editm");
      const m = state.meals.find(x => x.id === id);
      if (!m) return;
      // load into form
      mealTime.value = m.time;
      document.getElementById("mealType").value = m.type;
      document.getElementById("mealName").value = m.name || "";
      document.getElementById("kcalFinal").value = safeNum(m.final?.kcal,0) || "";
      document.getElementById("mealUnc").value = safeNum(m.unc,0.35).toFixed(2);
      // kcal range
      if (m.finalRange && m.finalRange.kcalLow && m.finalRange.kcalHigh) {
        document.getElementById("kcalLow").value = safeNum(m.finalRange.kcalLow,0) || "";
        document.getElementById("kcalHigh").value = safeNum(m.finalRange.kcalHigh,0) || "";
      } else {
        setKcalRangeFromFinal(safeNum(m.final?.kcal,0), safeNum(m.unc,0.35));
      }
      const sug = document.getElementById("mealTextSuggestions");
      if (sug) sug.textContent = "";
      document.getElementById("mealNote").value = m.note || "";
      // overwrite on next add: delete old and add new (simple)
      state.meals = state.meals.filter(x => x.id !== id);
      saveState().then(() => { setStatus("已进入编辑：修改后点“添加”保存"); });
      // photo: keep old photoId unless user re-uploads; we keep it by temporarily storing
      window.__editingMealPhotoId = m.photoId || "";
      window.__editingMealOriginalId = id;
      document.querySelector('.tab[data-tab="meals"]').click();
    });
  });
}

// Override addMeal when editing: keep old photo unless replaced
const oldAddMealHandler = document.getElementById("addMeal").onclick;

document.getElementById("addMeal").addEventListener("click", async () => {
  if (window.__editingMealOriginalId) {
    // if user did not upload new photo, keep old
    const file = document.getElementById("mealPhoto").files[0];
    if (!file && window.__editingMealPhotoId) {
      // inject into last added meal after normal handler adds it:
      // But we already handle creation in main handler; easiest: set a flag and patch state.meals[0]
      setTimeout(async () => {
        if (state.meals[0]) {
          state.meals[0].photoId = window.__editingMealPhotoId;
          await saveState();
          setStatus("已保存编辑（保留原照片）");
          window.__editingMealPhotoId = "";
          window.__editingMealOriginalId = "";
          renderAll();
        }
      }, 50);
    } else if (file && window.__editingMealPhotoId) {
      // user replaced photo; delete old after successful add
      setTimeout(async () => {
        await photoDel(window.__editingMealPhotoId);
        window.__editingMealPhotoId = "";
        window.__editingMealOriginalId = "";
        setStatus("已保存编辑（已替换照片）");
        renderAll();
      }, 200);
    } else {
      window.__editingMealOriginalId = "";
      window.__editingMealPhotoId = "";
    }
  }
});

// Workouts render
async function renderWorkouts() {
  const box = document.getElementById("woList");
  box.innerHTML = "";
  state.workouts.slice(0, 20).forEach(w => {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="itemHead">
        <div>
          <div class="itemTitle">${escapeHtml(w.type || "训练")} · ${escapeHtml(w.time.replace("T"," "))}</div>
          <div class="itemMeta">${fmtK(safeNum(w.minutes,0))} min · Avg HR ${fmtK(safeNum(w.hrAvg,0))} bpm · ${fmtK(safeNum(w.kcal,0))} kcal ${w.trimp ? `· TRIMP ${w.trimp}` : ""}</div>
          <div class="itemMeta">来源: ${escapeHtml(w.source || "manual")}${w.note ? ` · ${escapeHtml(w.note)}` : ""}</div>
        </div>
        <div class="itemActions">
          <button class="smallBtn" data-delw="${w.id}">删除</button>
        </div>
      </div>
    `;
    box.appendChild(div);
  });

  box.querySelectorAll("[data-delw]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-delw");
      state.workouts = state.workouts.filter(x => x.id !== id);
      await saveState();
      setStatus("已删除训练记录");
      renderAll();
    });
  });
}

function escapeHtml(s) {
  return String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

// Init
(async () => {
  setStatus("加载数据…");
  state = await loadState();
  // ensure profile defaults
  if (!state.profile) state.profile = defaultState().profile;
  state.profile.age = safeNum(state.profile.age, 21);
  state.profile.sex = state.profile.sex || "male";
  if (!state.profile.calFactor) state.profile.calFactor = 1.0;
  if (state.profile.budgetMode !== "high") state.profile.budgetMode = "mid";

  await saveState();
  fillProfileUI();
  mealTime.value = nowLocalISO();
  woTime.value = nowLocalISO();
  setStatus("准备就绪");
  renderAll();
})();
