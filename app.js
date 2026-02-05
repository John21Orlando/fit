// CutLog — local-first (IndexedDB)
// Data stays in browser. Export JSON for backup.

const STATUS = document.getElementById("status");

// ---------------------- Utils ----------------------
function setStatus(msg) {
  STATUS.textContent = msg;
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => (STATUS.textContent = "准备就绪"), 1800);
}

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function safeNum(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function fmtK(k) {
  if (!Number.isFinite(k)) return "0";
  return String(Math.round(k));
}

function nowLocalISO() {
  // yyyy-MM-ddTHH:mm
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dateKey(iso) {
  // iso like yyyy-MM-ddTHH:mm
  if (!iso) return "";
  return iso.slice(0, 10);
}

function parseISOToMs(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}

function boundedRange(mid, unc) {
  // unc 0~1 => relative half-width (capped)
  const u = clamp(unc, 0.05, 0.60);
  const half = mid * u;
  const low = Math.max(0, Math.round(mid - half));
  const high = Math.max(low, Math.round(mid + half));
  const m = Math.round((low + high) / 2);
  return { low, high, mid: m, u };
}

// ---------------------- IndexedDB ----------------------
const DB_NAME = "cutlog_db";
const DB_VER = 1;
const STORE = "state";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE], "readonly");
    const st = tx.objectStore(STORE);
    const req = st.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, val) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE], "readwrite");
    const st = tx.objectStore(STORE);
    const req = st.put(val, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

// photos
async function photoPut(key, blob) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["photos"], "readwrite");
    const st = tx.objectStore("photos");
    const req = st.put(blob, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function photoGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["photos"], "readonly");
    const st = tx.objectStore("photos");
    const req = st.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function photoDel(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["photos"], "readwrite");
    const st = tx.objectStore("photos");
    const req = st.delete(key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------- State ----------------------
const DEFAULT_STATE = {
  version: "v4",
  profile: {
    age: 21,
    sex: "male",
    weight: null,
    hrrest: null,
    hrmax: null,
    calFactor: 1.0,

    targetKcal: null,      // v4
    budgetMode: "mid"      // v4: "mid" | "high"
  },
  meals: [],
  workouts: [],
  weights: []
};

let state = structuredClone(DEFAULT_STATE);

async function loadState() {
  const s = await idbGet("state");
  if (s && typeof s === "object") {
    state = { ...structuredClone(DEFAULT_STATE), ...s };
    state.profile = { ...structuredClone(DEFAULT_STATE.profile), ...(s.profile || {}) };
    state.meals = Array.isArray(s.meals) ? s.meals : [];
    state.workouts = Array.isArray(s.workouts) ? s.workouts : [];
    state.weights = Array.isArray(s.weights) ? s.weights : [];
  } else {
    state = structuredClone(DEFAULT_STATE);
  }
}

async function saveState() {
  await idbPut("state", state);
}

// ---------------------- Tabs ----------------------
const tabs = Array.from(document.querySelectorAll(".tab"));
const views = {
  dash: document.getElementById("view-dash"),
  meals: document.getElementById("view-meals"),
  workouts: document.getElementById("view-workouts"),
  profile: document.getElementById("view-profile"),
  backup: document.getElementById("view-backup")
};

function switchTab(key) {
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === key));
  Object.keys(views).forEach((k) => views[k].classList.toggle("active", k === key));
  setStatus(`切换到：${tabs.find(t=>t.dataset.tab===key)?.textContent || key}`);
}

tabs.forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

// ---------------------- Meals: text estimation ----------------------
//
// Strategy:
// - Recognize common foods and typical kcal per 100g
// - Parse quantities (g/ml/个/片/碗/小把/勺/粒...)
// - If quantity missing: use conservative typical portion ranges
// - Output a bounded range (not absurdly wide)
//
// This is heuristic; for fat-loss control, range + consistency is the goal.

const FOOD_DB = [
  // staples
  { keys: ["米饭", "白米饭", "米"], kcalPer100g: 116, unitHints: { "碗": 180, "小碗": 150, "大碗": 250 } },
  { keys: ["面", "面条", "拉面"], kcalPer100g: 110, unitHints: { "碗": 250 } },
  { keys: ["馒头"], kcalPer100g: 223, unitHints: { "个": 60 } },
  { keys: ["面包", "吐司"], kcalPer100g: 265, unitHints: { "片": 25 } },
  { keys: ["燕麦", "麦片"], kcalPer100g: 380, unitHints: { "勺": 10, "把": 30 } },

  // protein
  { keys: ["鸡胸", "鸡胸肉"], kcalPer100g: 165, unitHints: {} },
  { keys: ["鸡腿"], kcalPer100g: 215, unitHints: { "只": 150 } },
  { keys: ["白斩鸡", "白切鸡"], kcalPer100g: 200, unitHints: { "份": 150 } },
  { keys: ["牛肉"], kcalPer100g: 250, unitHints: {} },
  { keys: ["猪肉", "五花肉"], kcalPer100g: 380, unitHints: {} },
  { keys: ["鱼", "三文鱼"], kcalPer100g: 208, unitHints: {} },
  { keys: ["鸡蛋", "蛋"], kcalPer100g: 143, unitHints: { "个": 50 } },
  { keys: ["豆腐"], kcalPer100g: 76, unitHints: { "块": 150 } },

  // dairy
  { keys: ["牛奶"], kcalPer100ml: 60, unitHints: { "杯": 250 } },
  { keys: ["酸奶"], kcalPer100g: 95, unitHints: { "杯": 200 } },

  // snacks
  { keys: ["葡萄干"], kcalPer100g: 299, unitHints: { "把": 30, "小把": 20, "粒": 0.6 } },
  { keys: ["坚果", "混合坚果", "花生", "腰果", "杏仁"], kcalPer100g: 600, unitHints: { "把": 25, "小把": 15, "颗": 1.2 } },
  { keys: ["巧克力"], kcalPer100g: 550, unitHints: { "块": 10 } },
  { keys: ["薯片"], kcalPer100g: 536, unitHints: { "包": 50 } },

  // fruits
  { keys: ["苹果"], kcalPer100g: 52, unitHints: { "个": 180 } },
  { keys: ["香蕉"], kcalPer100g: 89, unitHints: { "根": 120 } },
  { keys: ["橙子"], kcalPer100g: 47, unitHints: { "个": 200 } },
  { keys: ["葡萄"], kcalPer100g: 69, unitHints: { "串": 200 } },

  // cooking oil / sauces (often hidden)
  { keys: ["油", "食用油"], kcalPer100g: 900, unitHints: { "勺": 10, "汤匙": 14 } },
  { keys: ["沙拉酱", "蛋黄酱"], kcalPer100g: 680, unitHints: { "勺": 15 } },
  { keys: ["酱", "酱汁"], kcalPer100g: 150, unitHints: { "勺": 10 } }
];

function findFoodHits(text) {
  const hits = [];
  const t = text.toLowerCase();
  for (const item of FOOD_DB) {
    for (const k of item.keys) {
      if (t.includes(k.toLowerCase())) {
        hits.push(item);
        break;
      }
    }
  }
  return hits;
}

function matchQuantityNear(text, keyword) {
  // try to find patterns like "180g", "0.2kg", "250ml", "2个", "一碗", "小把", "20粒"
  // search near the keyword
  const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
  const windowText = idx >= 0 ? text.slice(Math.max(0, idx - 12), idx + keyword.length + 18) : text;

  // number + unit
  const m1 = windowText.match(/(\d+(?:\.\d+)?)\s*(g|kg|ml|l|个|颗|片|碗|杯|勺|汤匙|把|小把|粒|根|只|块|份|包)/i);
  if (m1) {
    return { n: parseFloat(m1[1]), unit: m1[2] };
  }

  // Chinese numerals common: 一/两/半
  // treat "一碗" / "半碗" / "一把" etc.
  const m2 = windowText.match(/(半|一|两|二|三|四|五)\s*(个|颗|片|碗|杯|勺|把|小把|粒|根|只|块|份|包)/);
  if (m2) {
    const map = { "半": 0.5, "一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5 };
    return { n: map[m2[1]] || 1, unit: m2[2] };
  }

  return null;
}

function toGramsFromUnit(n, unit, unitHints) {
  const u = unit.toLowerCase();
  if (u === "g") return n;
  if (u === "kg") return n * 1000;
  if (u === "ml") return n; // assume density ~1 for rough estimate
  if (u === "l") return n * 1000;

  // count-based units: if unitHints has mapping to grams per unit
  if (unitHints && unitHints[unit]) return n * unitHints[unit];

  // fallback rough mapping
  const fallback = {
    "个": 60,
    "颗": 1.2,
    "片": 25,
    "碗": 180,
    "杯": 250,
    "勺": 10,
    "汤匙": 14,
    "把": 30,
    "小把": 20,
    "粒": 0.6,
    "根": 120,
    "只": 150,
    "块": 150,
    "份": 150,
    "包": 50
  };
  if (fallback[unit]) return n * fallback[unit];
  return null;
}

function estimateKcalRangeFromText(text) {
  const raw = (text || "").trim();
  if (!raw) return { ok: false };

  const hits = findFoodHits(raw);
  if (hits.length === 0) {
    // unknown: give a conservative generic meal/snack range based on keywords
    const isSnack = /加餐|零食|甜|奶茶|咖啡|饮料|水果|坚果|饼干/.test(raw);
    const base = isSnack ? 180 : 550;
    const r = boundedRange(base, isSnack ? 0.45 : 0.40);
    return {
      ok: true,
      range: r,
      uncSuggested: r.u,
      explanation: `未识别具体食物：给出${isSnack ? "加餐" : "一餐"}的保守范围`,
      followups: "若写出份量（g/个/碗/包）会更准。"
    };
  }

  // If multiple foods mentioned, sum them.
  let midSum = 0;
  let lowSum = 0;
  let highSum = 0;

  let followups = [];
  let anyQty = false;

  for (const item of hits) {
    const key = item.keys[0];
    const qty = matchQuantityNear(raw, key);
    let gramsOrMl = null;

    if (qty) {
      const g = toGramsFromUnit(qty.n, qty.unit, item.unitHints);
      if (g != null) {
        gramsOrMl = g;
        anyQty = true;
      }
    }

    // compute kcal
    let kcalMid = 0;
    if (gramsOrMl != null) {
      if (item.kcalPer100g) kcalMid = (gramsOrMl / 100) * item.kcalPer100g;
      else if (item.kcalPer100ml) kcalMid = (gramsOrMl / 100) * item.kcalPer100ml;
    } else {
      // typical portion range if no qty
      // pick a typical portion mid by food type
      let typicalMid = 0;
      let typicalUnc = 0.45;

      const k0 = item.keys.join("|");
      if (/油|酱/.test(k0)) {
        typicalMid = 90;
        typicalUnc = 0.55;
        followups.push(`“${key}”建议写勺数/克数（油和酱最容易低估）。`);
      } else if (/米饭|面|面条|馒头|面包|燕麦/.test(k0)) {
        typicalMid = 250;
        typicalUnc = 0.40;
        followups.push(`“${key}”建议写“一碗/多少克/几片”。`);
      } else if (/鸡|牛|猪|鱼|蛋|豆腐/.test(k0)) {
        typicalMid = 280;
        typicalUnc = 0.45;
        followups.push(`“${key}”建议写“多少克/几块/几只”。`);
      } else if (/奶|酸奶/.test(k0)) {
        typicalMid = 160;
        typicalUnc = 0.40;
        followups.push(`“${key}”建议写“多少毫升/一杯多大”。`);
      } else if (/葡萄干|坚果|巧克力|薯片/.test(k0)) {
        typicalMid = 220;
        typicalUnc = 0.50;
        followups.push(`“${key}”建议写“多少粒/多少克/一小把”。`);
      } else if (/苹果|香蕉|橙|葡萄/.test(k0)) {
        typicalMid = 120;
        typicalUnc = 0.45;
        followups.push(`“${key}”建议写“几个/多少克”。`);
      } else {
        typicalMid = 220;
        typicalUnc = 0.50;
        followups.push(`“${key}”建议写份量（g/个/碗/包）。`);
      }

      const r = boundedRange(typicalMid, typicalUnc);
      lowSum += r.low;
      midSum += r.mid;
      highSum += r.high;
      continue;
    }

    // if qty-based
    // Give a small uncertainty even with qty (labels can vary), but tighter
    const unc = 0.12;
    const r = boundedRange(kcalMid, unc);
    lowSum += r.low;
    midSum += r.mid;
    highSum += r.high;
  }

  const totalMid = Math.round(midSum);
  const totalLow = Math.round(lowSum);
  const totalHigh = Math.max(totalLow, Math.round(highSum));

  // overall unc suggestion: if no qty, bigger
  const uncSuggested = anyQty ? 0.18 : 0.40;

  // keep range reasonable: avoid absurdly wide ratio
  const widthRatio = totalHigh > 0 ? (totalHigh - totalLow) / totalHigh : 0;
  let low = totalLow, high = totalHigh, mid = totalMid;

  if (widthRatio > 0.75) {
    // clamp
    const r = boundedRange(totalMid || 400, 0.55);
    low = r.low; high = r.high; mid = r.mid;
  }

  return {
    ok: true,
    range: { low, high, mid, u: uncSuggested },
    uncSuggested,
    explanation: hits.length === 1 ? `识别：${hits[0].keys[0]}` : `识别：${hits.map(h => h.keys[0]).join(" + ")}`,
    followups: followups.length ? `提示：${Array.from(new Set(followups)).slice(0,2).join("；")}` : ""
  };
}

// Apply range to inputs
function setKcalRangeFields(low, high) {
  document.getElementById("kcalLow").value = low ? Math.round(low) : "";
  document.getElementById("kcalHigh").value = high ? Math.round(high) : "";
}

// compress image to smaller blob
async function compressImageToBlob(file) {
  try {
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    await img.decode();

    const maxW = 1200;
    const scale = Math.min(1, maxW / img.width);
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    URL.revokeObjectURL(img.src);
    return blob;
  } catch {
    return null;
  }
}

// ---------------------- Workouts: energy estimation ----------------------
// Keytel et al. HR equations (approx): kcal/min = (-55.0969 + 0.6309*HR + 0.1988*W + 0.2017*Age)/4.184 for men
// women: (-20.4022 + 0.4472*HR - 0.1263*W + 0.074*Age)/4.184
// Here: use average HR and duration. Apply user calibration factor.

function estimateKcalFromHr(avgHr, minutes, profile) {
  const age = safeNum(profile.age, 21);
  const w = safeNum(profile.weight, 70);
  const hr = safeNum(avgHr, 120);
  const min = safeNum(minutes, 30);

  let kcalMin = 0;
  if (profile.sex === "female") {
    kcalMin = (-20.4022 + 0.4472 * hr - 0.1263 * w + 0.074 * age) / 4.184;
  } else {
    kcalMin = (-55.0969 + 0.6309 * hr + 0.1988 * w + 0.2017 * age) / 4.184;
  }

  kcalMin = Math.max(1, kcalMin);
  const factor = clamp(safeNum(profile.calFactor, 1.0), 0.7, 1.3);
  return Math.round(kcalMin * min * factor);
}

// ---------------------- DOM refs ----------------------
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

// ---------------------- Meals CRUD ----------------------
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

function clearMealForm(resetTime = false) {
  if (resetTime) mealTime.value = nowLocalISO();
  ["mealName","mealNote"].forEach(id => document.getElementById(id).value = "");
  ["kcalFinal","kcalLow","kcalHigh"].forEach(id => document.getElementById(id).value = "");
  mealManual = false;
  document.getElementById("mealUnc").value = "0.35";
  document.getElementById("mealPhoto").value = "";
  const sug = document.getElementById("mealTextSuggestions");
  if (sug) sug.textContent = "";
}

document.getElementById("clearMealForm").addEventListener("click", () => {
  clearMealForm(true);
  setStatus("已清空");
});

// ---------------------- Workouts CRUD ----------------------
document.getElementById("addWorkoutManual").addEventListener("click", async () => {
  const time = woTime.value || nowLocalISO();
  const type = (document.getElementById("woType").value || "").trim() || "训练";
  const dur = safeNum(document.getElementById("woDur").value, 0);
  const hr = safeNum(document.getElementById("woHr").value, 0);
  const rpe = safeNum(document.getElementById("woRpe").value, 0) || null;
  const note = (document.getElementById("woNote").value || "").trim();

  if (!dur || !hr) {
    setStatus("请至少填写时长和平均心率");
    return;
  }

  const kcal = estimateKcalFromHr(hr, dur, state.profile);

  const wo = {
    id: uid(),
    time,
    type,
    durationMin: dur,
    avgHr: hr,
    kcal,
    rpe,
    note
  };

  state.workouts.unshift(wo);
  await saveState();
  clearWorkoutForm(false);
  setStatus(`已添加训练（估算 ${kcal} kcal）`);
  renderAll();
});

function clearWorkoutForm(resetTime = false) {
  if (resetTime) woTime.value = nowLocalISO();
  ["woType","woDur","woHr","woRpe","woNote"].forEach(id => document.getElementById(id).value = "");
}

document.getElementById("clearWoForm").addEventListener("click", () => {
  clearWorkoutForm(true);
  setStatus("已清空");
});

// ---------------------- CSV import for HR series ----------------------
let _csvRaw = "";
let _csvHeaders = [];
let _csvRows = [];

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (lines.length < 2) return { headers: [], rows: [] };

  // naive CSV: split by comma; supports quoted commas in a minimal way
  function splitLine(line) {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.replace(/^"|"$/g, "").trim());
  }

  const headers = splitLine(lines[0]);
  const rows = lines.slice(1).map(splitLine).filter(r => r.length >= 2);
  return { headers, rows };
}

function inferTimeParser(sample) {
  // accept ISO, or ms, or yyyy/MM/dd HH:mm:ss, etc.
  if (!sample) return (s) => Date.parse(s);
  const s = sample.trim();
  if (/^\d{13}$/.test(s)) return (x) => Number(x);
  if (/^\d{10}$/.test(s)) return (x) => Number(x) * 1000;
  return (x) => Date.parse(x);
}

document.getElementById("importHrCsv").addEventListener("click", async () => {
  const file = document.getElementById("hrCsv").files[0];
  if (!file) {
    setStatus("请选择 CSV 文件");
    return;
  }
  _csvRaw = await file.text();
  const { headers, rows } = parseCsv(_csvRaw);
  if (!headers.length || !rows.length) {
    setStatus("CSV 解析失败：请检查格式");
    return;
  }
  _csvHeaders = headers;
  _csvRows = rows;

  const colTime = document.getElementById("colTime");
  const colHr = document.getElementById("colHr");
  colTime.innerHTML = "";
  colHr.innerHTML = "";
  headers.forEach((h, i) => {
    const opt1 = document.createElement("option");
    opt1.value = String(i);
    opt1.textContent = `${i}: ${h}`;
    colTime.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = String(i);
    opt2.textContent = `${i}: ${h}`;
    colHr.appendChild(opt2);
  });

  // heuristic pick
  const lower = headers.map(h => h.toLowerCase());
  const timeGuess = lower.findIndex(h => /time|timestamp|date/.test(h));
  const hrGuess = lower.findIndex(h => /hr|heart|pulse/.test(h));
  if (timeGuess >= 0) colTime.value = String(timeGuess);
  if (hrGuess >= 0) colHr.value = String(hrGuess);

  document.getElementById("csvMapper").classList.remove("hidden");

  // preview first 8 lines
  const preview = _csvRows.slice(0, 8).map(r => r.join(" , ")).join("\n");
  document.getElementById("csvPreview").textContent = preview;
  setStatus("已读取 CSV，请选择列映射");
});

document.getElementById("cancelImportCsv").addEventListener("click", () => {
  document.getElementById("csvMapper").classList.add("hidden");
  setStatus("已取消");
});

document.getElementById("confirmImportCsv").addEventListener("click", async () => {
  const iTime = Number(document.getElementById("colTime").value);
  const iHr = Number(document.getElementById("colHr").value);
  const type = (document.getElementById("csvWoType").value || "").trim() || "训练";
  const note = (document.getElementById("csvWoNote").value || "").trim();

  const tSample = _csvRows[0]?.[iTime] || "";
  const parseTime = inferTimeParser(tSample);

  const points = [];
  for (const r of _csvRows) {
    const t = parseTime(r[iTime]);
    const hr = safeNum(r[iHr], NaN);
    if (Number.isFinite(t) && Number.isFinite(hr)) points.push([t, hr]);
  }
  if (points.length < 10) {
    setStatus("有效数据太少：请确认时间列/心率列");
    return;
  }

  points.sort((a, b) => a[0] - b[0]);

  const startMs = points[0][0];
  const endMs = points[points.length - 1][0];
  const durationMin = Math.max(1, Math.round((endMs - startMs) / 60000));

  const avgHr = Math.round(points.reduce((s, p) => s + p[1], 0) / points.length);
  const kcal = estimateKcalFromHr(avgHr, durationMin, state.profile);

  const wo = {
    id: uid(),
    time: new Date(startMs).toISOString().slice(0, 16),
    type,
    durationMin,
    avgHr,
    kcal,
    rpe: null,
    note: note || "CSV 导入"
  };

  state.workouts.unshift(wo);
  await saveState();

  document.getElementById("csvMapper").classList.add("hidden");
  document.getElementById("hrCsv").value = "";
  setStatus(`已导入训练（${durationMin} min，avgHR ${avgHr}，估算 ${kcal} kcal）`);
  renderAll();
});

// ---------------------- Weights ----------------------
const wDate = document.getElementById("wDate");
const wKg = document.getElementById("wKg");
wDate.value = dateKey(nowLocalISO());

document.getElementById("addWeight").addEventListener("click", async () => {
  const d = wDate.value;
  const kg = safeNum(wKg.value, 0);
  if (!d || !kg) {
    setStatus("请填写日期和体重");
    return;
  }

  // replace if same date exists
  const i = state.weights.findIndex(x => x.date === d);
  if (i >= 0) state.weights[i] = { date: d, kg };
  else state.weights.unshift({ date: d, kg });

  state.weights.sort((a, b) => (a.date < b.date ? 1 : -1));
  await saveState();
  setStatus("已记录体重");
  renderAll();
});

// ---------------------- Profile ----------------------
function renderProfile() {
  const p = state.profile;
  document.getElementById("age").value = safeNum(p.age, 21);
  document.getElementById("sex").value = p.sex || "male";
  document.getElementById("weight").value = p.weight ?? "";
  document.getElementById("hrrest").value = p.hrrest ?? "";
  document.getElementById("hrmax").value = p.hrmax ?? "";
  document.getElementById("calFactor").value = safeNum(p.calFactor, 1.0).toFixed(2);

  document.getElementById("targetKcal").value = p.targetKcal ?? "";
  document.getElementById("budgetMode").value = p.budgetMode || "mid";
}

document.getElementById("saveProfile").addEventListener("click", async () => {
  const p = state.profile;
  p.age = clamp(safeNum(document.getElementById("age").value, 21), 10, 90);
  p.sex = document.getElementById("sex").value || "male";
  p.weight = safeNum(document.getElementById("weight").value, NaN);
  if (!Number.isFinite(p.weight)) p.weight = null;

  p.hrrest = safeNum(document.getElementById("hrrest").value, NaN);
  if (!Number.isFinite(p.hrrest)) p.hrrest = null;

  p.hrmax = safeNum(document.getElementById("hrmax").value, NaN);
  if (!Number.isFinite(p.hrmax)) p.hrmax = null;

  p.calFactor = clamp(safeNum(document.getElementById("calFactor").value, 1.0), 0.7, 1.3);

  p.targetKcal = safeNum(document.getElementById("targetKcal").value, NaN);
  if (!Number.isFinite(p.targetKcal) || p.targetKcal <= 0) p.targetKcal = null;

  p.budgetMode = document.getElementById("budgetMode").value || "mid";

  await saveState();
  setStatus("已保存个人信息");
  renderAll();
});

document.getElementById("resetProfile").addEventListener("click", async () => {
  state.profile = structuredClone(DEFAULT_STATE.profile);
  await saveState();
  setStatus("已重置");
  renderAll();
});

// ---------------------- Renderers ----------------------
function getMealKcalRange(m) {
  if (m.finalRange && Number.isFinite(m.finalRange.kcalLow) && Number.isFinite(m.finalRange.kcalHigh)) {
    const low = Math.max(0, Math.round(m.finalRange.kcalLow));
    const high = Math.max(low, Math.round(m.finalRange.kcalHigh));
    const mid = Math.round((low + high) / 2);
    return { low, high, mid };
  }
  const mid = safeNum(m.final?.kcal, 0);
  const r = boundedRange(mid, clamp(safeNum(m.unc, 0.35), 0.05, 0.60));
  return { low: r.low, high: r.high, mid: r.mid };
}

function dailyBudgetValueFromRange(rr, budgetMode) {
  if (budgetMode === "high") return rr.high;
  return rr.mid;
}

async function renderMeals() {
  const list = document.getElementById("mealList");
  list.innerHTML = "";

  for (const m of state.meals.slice(0, 30)) {
    const rr = getMealKcalRange(m);

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="itemHead">
        <div>
          <div class="itemTitle">${m.type || "餐"} · ${dateKey(m.time)} ${String(m.time||"").slice(11,16)}</div>
          <div class="itemMeta">${(m.name || "").replace(/</g,"&lt;")}</div>
          <div class="itemMeta">kcal: ${fmtK(rr.low)}–${fmtK(rr.high)} (mid ${fmtK(rr.mid)}) · 不确定性 ${safeNum(m.unc,0.35).toFixed(2)}</div>
          ${m.note ? `<div class="itemMeta">${m.note.replace(/</g,"&lt;")}</div>` : ``}
        </div>
        <div class="itemActions">
          <button class="smallBtn" data-act="edit">编辑</button>
          <button class="smallBtn" data-act="del">删除</button>
        </div>
      </div>
    `;

    // photo
    if (m.photoId) {
      const blob = await photoGet(m.photoId);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const img = document.createElement("img");
        img.src = url;
        img.className = "thumb";
        img.onload = () => URL.revokeObjectURL(url);
        div.appendChild(img);
      }
    }

    div.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (m.photoId) await photoDel(m.photoId);
      state.meals = state.meals.filter(x => x.id !== m.id);
      await saveState();
      setStatus("已删除");
      renderAll();
    });

    div.querySelector('[data-act="edit"]').addEventListener("click", async () => {
      // fill form
      mealTime.value = m.time || nowLocalISO();
      document.getElementById("mealType").value = m.type || "早餐";
      document.getElementById("mealName").value = m.name || "";
      document.getElementById("mealNote").value = m.note || "";

      const rr2 = getMealKcalRange(m);
      document.getElementById("kcalFinal").value = safeNum(m.final?.kcal, rr2.mid) || rr2.mid || "";
      document.getElementById("kcalLow").value = rr2.low || "";
      document.getElementById("kcalHigh").value = rr2.high || "";
      document.getElementById("mealUnc").value = safeNum(m.unc, 0.35).toFixed(2);

      // remove the old entry first (so saving will insert as new at top)
      if (m.photoId) {
        // keep photo unless user adds new one; current UI doesn't re-attach automatically
        setStatus("编辑：如需更换照片请重新选择文件");
      } else {
        setStatus("进入编辑：修改后点“添加”保存");
      }
      state.meals = state.meals.filter(x => x.id !== m.id);
      await saveState();
      renderAll();
      switchTab("meals");
      mealManual = true; // editing counts as manual
    });

    list.appendChild(div);
  }
}

function renderWorkouts() {
  const list = document.getElementById("woList");
  list.innerHTML = "";

  for (const w of state.workouts.slice(0, 30)) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="itemHead">
        <div>
          <div class="itemTitle">${(w.type||"训练").replace(/</g,"&lt;")} · ${dateKey(w.time)} ${String(w.time||"").slice(11,16)}</div>
          <div class="itemMeta">时长 ${fmtK(w.durationMin)} min · avgHR ${fmtK(w.avgHr)} bpm · 估算 ${fmtK(w.kcal)} kcal</div>
          ${w.note ? `<div class="itemMeta">${w.note.replace(/</g,"&lt;")}</div>` : ``}
        </div>
        <div class="itemActions">
          <button class="smallBtn" data-act="del">删除</button>
        </div>
      </div>
    `;
    div.querySelector('[data-act="del"]').addEventListener("click", async () => {
      state.workouts = state.workouts.filter(x => x.id !== w.id);
      await saveState();
      setStatus("已删除训练");
      renderAll();
    });
    list.appendChild(div);
  }
}

function renderWeights() {
  const list = document.getElementById("weightList");
  list.innerHTML = "";
  const items = state.weights.slice(0, 14);

  for (const it of items) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="itemHead">
        <div>
          <div class="itemTitle">${it.date}</div>
          <div class="itemMeta">${it.kg.toFixed(1)} kg</div>
        </div>
        <div class="itemActions">
          <button class="smallBtn" data-act="del">删除</button>
        </div>
      </div>
    `;
    div.querySelector('[data-act="del"]').addEventListener("click", async () => {
      state.weights = state.weights.filter(x => x.date !== it.date);
      await saveState();
      setStatus("已删除体重记录");
      renderAll();
    });
    list.appendChild(div);
  }
}

function getTodayMeals() {
  const today = dateKey(nowLocalISO());
  return state.meals.filter(m => dateKey(m.time) === today);
}

function getTodayWorkouts() {
  const today = dateKey(nowLocalISO());
  return state.workouts.filter(w => dateKey(w.time) === today);
}

function renderDash() {
  const todayMeals = getTodayMeals();
  const todayWorkouts = getTodayWorkouts();

  let kcalLow = 0, kcalHigh = 0, kcalMid = 0;
  for (const m of todayMeals) {
    const rr = getMealKcalRange(m);
    kcalLow += rr.low;
    kcalHigh += rr.high;
    kcalMid += rr.mid;
  }
  const workoutKcal = todayWorkouts.reduce((s, w) => s + safeNum(w.kcal, 0), 0);

  const mode = state.profile.budgetMode || "mid";
  const usedForBudget = (mode === "high") ? kcalHigh : kcalMid;

  const target = state.profile.targetKcal;
  const remain = Number.isFinite(target) ? Math.round(target - usedForBudget) : null;

  const lines = [];
  lines.push(`摄入：${fmtK(kcalLow)}–${fmtK(kcalHigh)} kcal（mid ${fmtK(kcalMid)}）`);
  lines.push(`训练：≈ ${fmtK(workoutKcal)} kcal`);
  if (Number.isFinite(target)) {
    lines.push(`目标：${fmtK(target)} kcal · 口径：${mode === "high" ? "上限(high)" : "中值(mid)"}`);
    lines.push(`剩余预算：${remain >= 0 ? fmtK(remain) : "-" + fmtK(Math.abs(remain))} kcal`);
  } else {
    lines.push(`目标：未设置（去“个人”页填每日目标 kcal）`);
  }

  document.getElementById("todaySummary").textContent = lines.join("  |  ");

  // week summary
  const box = document.getElementById("weekSummary");
  box.innerHTML = "";

  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);

    const meals = state.meals.filter(m => dateKey(m.time) === key);
    let low=0, high=0, mid=0;
    for (const m of meals) {
      const rr = getMealKcalRange(m);
      low += rr.low; high += rr.high; mid += rr.mid;
    }

    const used = (mode === "high") ? high : mid;
    const rem = Number.isFinite(target) ? Math.round(target - used) : null;

    const div = document.createElement("div");
    div.className = "dayBox";
    div.innerHTML = `
      <div class="d">${key.slice(5)}</div>
      <div class="k">摄入 ${fmtK(low)}–${fmtK(high)} (mid ${fmtK(mid)})</div>
      ${Number.isFinite(target) ? `<div class="k">剩余 ${rem >= 0 ? fmtK(rem) : "-" + fmtK(Math.abs(rem))}（按${mode === "high" ? "high" : "mid"}）</div>` : `<div class="k">目标未设</div>`}
    `;
    box.appendChild(div);
  }
}

function renderAll() {
  renderProfile();
  renderMeals();
  renderWorkouts();
  renderWeights();
  renderDash();
}

// ---------------------- Backup / Import ----------------------
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportState(includePhotos = true) {
  const payload = {
    exportedAt: new Date().toISOString(),
    state: state
  };

  if (includePhotos) {
    payload.photos = {};
    // enumerate photo keys by scanning meals
    for (const m of state.meals) {
      if (m.photoId) {
        const blob = await photoGet(m.photoId);
        if (blob) {
          const buf = await blob.arrayBuffer();
          const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
          payload.photos[m.photoId] = { type: blob.type || "image/jpeg", b64 };
        }
      }
    }
  }

  return JSON.stringify(payload);
}

document.getElementById("exportBtn").addEventListener("click", async () => {
  const json = await exportState(true);
  download(`cutlog_backup_${Date.now()}.json`, json, "application/json");
  setStatus("已导出（含照片）");
});

document.getElementById("exportNoPhotosBtn").addEventListener("click", async () => {
  const json = await exportState(false);
  download(`cutlog_backup_${Date.now()}_nophoto.json`, json, "application/json");
  setStatus("已导出（不含照片）");
});

document.getElementById("importBtn").addEventListener("click", async () => {
  const file = document.getElementById("importFile").files[0];
  if (!file) {
    setStatus("请选择 JSON 文件");
    return;
  }
  try {
    const txt = await file.text();
    const payload = JSON.parse(txt);
    const s = payload.state;
    if (!s || typeof s !== "object") throw new Error("bad state");
    state = { ...structuredClone(DEFAULT_STATE), ...s };
    state.profile = { ...structuredClone(DEFAULT_STATE.profile), ...(s.profile || {}) };
    state.meals = Array.isArray(s.meals) ? s.meals : [];
    state.workouts = Array.isArray(s.workouts) ? s.workouts : [];
    state.weights = Array.isArray(s.weights) ? s.weights : [];

    // photos
    if (payload.photos && typeof payload.photos === "object") {
      for (const [k, v] of Object.entries(payload.photos)) {
        if (v && v.b64) {
          const bin = atob(v.b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: v.type || "image/jpeg" });
          await photoPut(k, blob);
        }
      }
    }

    await saveState();
    setStatus("导入成功");
    renderAll();
  } catch {
    setStatus("导入失败：JSON 格式不对或文件损坏");
  }
});

document.getElementById("wipeBtn").addEventListener("click", async () => {
  const ok = confirm("确定要清空本地数据吗？此操作不可恢复。");
  if (!ok) return;

  // delete db
  indexedDB.deleteDatabase(DB_NAME);
  state = structuredClone(DEFAULT_STATE);
  setStatus("已清空");
  setTimeout(() => location.reload(), 300);
});

// ---------------------- Init ----------------------
(async function init() {
  await loadState();
  renderAll();
  setStatus("已加载本地数据");
})();
