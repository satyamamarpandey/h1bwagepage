/* =========================================================
   app.js — Improved accuracy + no dropdown on page load (FINAL)
   ✅ Uses your existing JSON files (no change):
      ./data/roles.json
      ./data/wage_index.json
      ./data/zip_index.json

   ✅ Fix 1: "Static AI closest role" is domain-aware:
      - Strongly prefers TECH / ANALYTICS roles for queries like:
        "data engineer", "quant", "quantitative analyst", "ml", "ai", etc.
      - Hybrid scorer:
         (A) keyword intent boosts
         (B) token overlap
         (C) trigram similarity (fallback)
      - Prevents bad matches (e.g., "Cook" for "Quant")

   ✅ Fix 2: Dropdown does NOT show on first load.
      - Only shows when user focuses or types in roleInput.

   ✅ Fix 3: Press Enter in “Can’t find your role?” triggers Find closest role.

   ✅ Keeps your wage logic exactly as before.
========================================================= */

const roleInput = document.getElementById("roleInput");
const roleList = document.getElementById("roleList");
const socCodeEl = document.getElementById("socCode");

const customRoleInput = document.getElementById("customRoleInput");
const matchRoleBtn = document.getElementById("matchRoleBtn");
const matchRoleMeta = document.getElementById("matchRoleMeta");

const zipInput = document.getElementById("zipInput");
const zipMeta = document.getElementById("zipMeta");

const salaryInput = document.getElementById("salaryInput");
const checkBtn = document.getElementById("checkBtn");
const resultBox = document.getElementById("result");

let ROLES = [];          // [{soccode, Title}]
let WAGE_INDEX = {};     // {"Area|SocCode": [L1,L2,L3,L4]}  (hourly)
let ZIP_INDEX = {};      // {"10001": {area, areaName, city, stateAb, county}}

let roleTimer = null;
let rolesReady = false;

/* ---------------------------
   Helpers
--------------------------- */
function normZip(z) {
    return String(z || "").replace(/\D/g, "").slice(0, 5).padStart(5, "0");
}

function annualFromHourly(h) {
    return Math.round(Number(h) * 2080);
}

function formatUSD(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "—";
    return x.toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0
    });
}

function escapeHTML(s) {
    return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

/* ---------------------------
   Wage rule (your logic)
--------------------------- */
function wageLevelRule(hourly, l1, l2, l3, l4) {
    if (hourly < l1) return "Not Qualified";
    if (hourly < l2) return "I";
    if (hourly < l3) return "II";
    if (hourly < l4) return "III";
    return "IV";
}

/* ---------------------------
   Dropdown rendering
--------------------------- */
function showRoles(items) {
    roleList.innerHTML = "";
    if (!items.length) {
        roleList.classList.add("hidden");
        return;
    }

    items.forEach((r) => {
        const div = document.createElement("div");
        div.className = "item";
        div.innerHTML = `
      <div><b>${escapeHTML(r.Title)}</b></div>
      <div class="code">${escapeHTML(r.soccode)}</div>
    `;
        div.onclick = () => {
            roleInput.value = r.Title;
            socCodeEl.value = r.soccode;
            roleList.classList.add("hidden");
            if (matchRoleMeta) matchRoleMeta.textContent = "";
        };
        roleList.appendChild(div);
    });

    roleList.classList.remove("hidden");
}

function hideRoles() {
    roleList.classList.add("hidden");
}

/* ---------------------------
   Better matching for dropdown typing
   - shows only on focus/type (NOT on load)
--------------------------- */
function filterRolesForDropdown(q) {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return ROLES
        .filter(r => r.Title.toLowerCase().includes(s) || String(r.soccode).includes(s))
        .slice(0, 20);
}

roleInput.addEventListener("focus", () => {
    if (!rolesReady) return;
    if (roleInput.value.trim().length >= 1) {
        showRoles(filterRolesForDropdown(roleInput.value));
    }
});

roleInput.addEventListener("input", () => {
    clearTimeout(roleTimer);

    const q = roleInput.value.trim().toLowerCase();
    socCodeEl.value = ""; // invalidate SOC if user edits text

    roleTimer = setTimeout(() => {
        if (!q) {
            hideRoles(); // ✅ do NOT show dropdown for empty input
            return;
        }
        showRoles(filterRolesForDropdown(q));
    }, 120);
});

document.addEventListener("click", (e) => {
    if (!roleList.contains(e.target) && e.target !== roleInput) hideRoles();
});

/* ---------------------------
   ZIP autofill meta (kept)
--------------------------- */
zipInput.addEventListener("input", () => {
    zipInput.value = zipInput.value.replace(/\D/g, "").slice(0, 5);
    const z = normZip(zipInput.value);

    if (z.length !== 5) { zipMeta.textContent = ""; return; }

    const info = ZIP_INDEX[z];
    if (!info) { zipMeta.textContent = "ZIP not found in mapping."; return; }

    const areaName = info.areaName ? info.areaName : "";
    const area = info.area ? ` (Area ${info.area})` : "";
    zipMeta.textContent = `${info.city}, ${info.stateAb} • ${areaName}${area}`;
});

/* =========================================================
   "Static AI" closest role — appropriate matching
========================================================= */

/** Titles we want to prioritize for tech/analytics-like queries */
const PREFERRED_TITLES = new Set([
    "Data Scientists",
    "Operations Research Analysts",
    "Statisticians",
    "Computer and Information Research Scientists",
    "Information Security Analysts",
    "Software Developers",
    "Database Administrators",
    "Database Architects",
    "Computer Systems Analysts",
    "Computer Occupations, All Other",
    "Financial and Investment Analysts",
    "Financial Risk Specialists",
    "Actuaries",
    "Management Analysts",
]);

/** Intent keywords -> boosts toward specific titles */
const INTENT_BOOSTS = [
    // data engineering-ish
    {
        keys: ["data engineer", "etl", "pipeline", "data pipelines", "spark", "airflow", "big data", "warehouse", "dbt"],
        boostTitles: ["Data Scientists", "Operations Research Analysts", "Database Architects", "Database Administrators", "Computer Occupations, All Other", "Computer Systems Analysts"]
    },

    // quant-ish
    {
        keys: ["quant", "quantitative", "quant analyst", "quantitative analyst", "quant research", "trading", "alpha", "derivatives"],
        boostTitles: ["Data Scientists", "Operations Research Analysts", "Statisticians", "Actuaries", "Financial Risk Specialists", "Financial and Investment Analysts"]
    },

    // ML/AI-ish
    {
        keys: ["ml", "machine learning", "ai", "deep learning", "model", "predictive"],
        boostTitles: ["Data Scientists", "Computer and Information Research Scientists", "Statisticians", "Operations Research Analysts"]
    },

    // analytics-ish
    {
        keys: ["analyst", "analytics", "insights", "bi", "business intelligence", "reporting"],
        boostTitles: ["Operations Research Analysts", "Data Scientists", "Financial and Investment Analysts", "Management Analysts"]
    },
];

function normalizeText(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokens(s) {
    const t = normalizeText(s);
    if (!t) return [];
    const parts = t.split(" ").filter(Boolean);
    const out = new Set(parts);
    for (let i = 0; i < parts.length - 1; i++) out.add(parts[i] + " " + parts[i + 1]);
    return Array.from(out);
}

function trigrams(s) {
    const t = `  ${s}  `;
    const grams = [];
    for (let i = 0; i < t.length - 2; i++) grams.push(t.slice(i, i + 3));
    return grams;
}

function trigramSimilarity(a, b) {
    const A = trigrams(a);
    const B = trigrams(b);
    const counts = new Map();
    for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);

    let intersect = 0;
    for (const g of B) {
        const c = counts.get(g) || 0;
        if (c > 0) {
            intersect++;
            counts.set(g, c - 1);
        }
    }
    const denom = A.length + B.length;
    return denom ? (2 * intersect) / denom : 0;
}

function tokenOverlapScore(qTokens, titleTokens) {
    if (!qTokens.length || !titleTokens.length) return 0;
    const set = new Set(titleTokens);
    let hit = 0;
    for (const t of qTokens) if (set.has(t)) hit++;
    return hit / Math.max(3, Math.min(10, qTokens.length));
}

function isTechIntent(qNorm) {
    const k = [
        "data", "engineer", "etl", "pipeline", "spark", "airflow", "db", "sql",
        "quant", "quantitative", "analyst", "ml", "machine learning", "ai",
        "science", "scientist", "statistics", "model", "predict",
    ];
    return k.some(x => qNorm.includes(x));
}

function intentBoostScore(qNorm, title) {
    let score = 0;
    for (const rule of INTENT_BOOSTS) {
        const hit = rule.keys.some(k => qNorm.includes(k));
        if (!hit) continue;
        if (rule.boostTitles.includes(title)) score += 1.2;
    }
    return score;
}

function shouldPenalizeForTech(title) {
    const bad = [
        "cooks", "dishwashers", "bartenders", "hosts and hostesses",
        "waiters", "waitresses", "food", "restaurant", "fast food"
    ];
    const t = title.toLowerCase();
    return bad.some(b => t.includes(b));
}

function findClosestRole(userText) {
    const qNorm = normalizeText(userText);
    if (!qNorm) return { best: null, score: 0 };

    const qTokens = tokens(qNorm);
    const tech = isTechIntent(qNorm);

    // Candidate pool
    let candidates = ROLES;
    if (tech) {
        const preferred = ROLES.filter(r => PREFERRED_TITLES.has(r.Title));
        if (preferred.length) candidates = preferred;
    }

    let best = null;
    let bestScore = -999;

    for (const r of candidates) {
        const titleNorm = normalizeText(r.Title);
        const titleTokens = tokens(titleNorm);

        const tri = trigramSimilarity(qNorm, titleNorm);     // 0..1
        const tok = tokenOverlapScore(qTokens, titleTokens); // ~0..1
        const boost = intentBoostScore(qNorm, r.Title);      // 0..N

        let score = (0.85 * tri) + (0.95 * tok) + boost;

        if (tech && shouldPenalizeForTech(r.Title)) score -= 2.5;
        if (tech && r.Title === "Data Scientists") score += 0.7;

        if (score > bestScore) {
            bestScore = score;
            best = r;
        }
    }

    const confidence = Math.max(0, Math.min(1, (bestScore + 0.5) / 3));
    if (!best || bestScore < 0.35) return { best: null, score: confidence };

    return { best, score: confidence };
}

/* Hook up "Find closest role" button */
if (matchRoleBtn && customRoleInput) {
    matchRoleBtn.addEventListener("click", () => {
        const q = customRoleInput.value.trim();
        if (!q) {
            if (matchRoleMeta) matchRoleMeta.textContent = "Type your role above, then click “Find closest role”.";
            return;
        }

        const { best, score } = findClosestRole(q);

        if (!best) {
            if (matchRoleMeta) matchRoleMeta.textContent =
                "Couldn’t confidently match. Try a clearer title (e.g., “Data Engineer”, “Quant Analyst”, “ML Engineer”).";
            return;
        }

        roleInput.value = best.Title;
        socCodeEl.value = best.soccode;
        hideRoles();

        if (matchRoleMeta) matchRoleMeta.textContent =
            `Closest match: ${best.Title} (${best.soccode}) • confidence ${Math.round(score * 100)}%`;
    });
}

/* Press Enter in “Can’t find your role?” => triggers Find closest role */
(() => {
    if (!customRoleInput || !matchRoleBtn) return;
    customRoleInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            matchRoleBtn.click();
        }
    });
})();

/* ---------------------------
   Check wage level
--------------------------- */
checkBtn.addEventListener("click", () => {
    resultBox.classList.add("hidden");
    resultBox.innerHTML = "";

    const soc = (socCodeEl.value || "").trim();
    const zip = normZip(zipInput.value);
    const annual = Number(salaryInput.value);

    if (!soc) { alert("Please select a role from the dropdown (SOC code required)."); return; }
    if (zip.length !== 5 || !ZIP_INDEX[zip]) { alert("Please enter a valid ZIP that exists in mapping."); return; }
    if (!annual || annual <= 0) { alert("Please enter a valid annual salary."); return; }

    const zipInfo = ZIP_INDEX[zip];
    const key = `${zipInfo.area}|${soc}`;
    const levels = WAGE_INDEX[key];

    if (!levels) {
        resultBox.classList.remove("hidden");
        resultBox.innerHTML = `
      <div class="title">No benchmark found</div>
      <div class="help">No wage thresholds found for SOC <b>${escapeHTML(soc)}</b> in Area <b>${escapeHTML(zipInfo.area)}</b>.</div>
    `;
        return;
    }

    const [l1, l2, l3, l4] = levels.map(Number);
    const hourly = annual / 2080.0;
    const level = wageLevelRule(hourly, l1, l2, l3, l4);

    const roleTitle = roleInput.value ? roleInput.value : soc;
    const locationLine = `${zipInfo.city}, ${zipInfo.stateAb} • ${zipInfo.areaName} (Area ${zipInfo.area})`;

    resultBox.classList.remove("hidden");
    resultBox.innerHTML = `
    <div class="title">Result</div>

    <div class="kv">
      <div class="k">Estimated wage level</div>
      <div class="v"><b>${escapeHTML(level)}</b></div>

      <div class="k">Role</div>
      <div class="v">${escapeHTML(roleTitle)} <span class="pill">${escapeHTML(soc)}</span></div>

      <div class="k">Location</div>
      <div class="v">${escapeHTML(locationLine)}</div>

      <div class="k">Entered salary</div>
      <div class="v">${formatUSD(annual)}</div>
    </div>

    <div class="pills">
      <div class="pill">Level I: ${formatUSD(annualFromHourly(l1))}</div>
      <div class="pill">Level II: ${formatUSD(annualFromHourly(l2))}</div>
      <div class="pill">Level III: ${formatUSD(annualFromHourly(l3))}</div>
      <div class="pill">Level IV: ${formatUSD(annualFromHourly(l4))}</div>
    </div>
  `;
});

/* ---------------------------
   Load data on startup
   ✅ Do NOT show dropdown on load
--------------------------- */
(async function init() {
    try {
        const [roles, wageIndex, zipIndex] = await Promise.all([
            fetch("./data/roles.json").then((r) => r.json()),
            fetch("./data/wage_index.json").then((r) => r.json()),
            fetch("./data/zip_index.json").then((r) => r.json()),
        ]);

        ROLES = Array.isArray(roles) ? roles : [];
        WAGE_INDEX = wageIndex || {};
        ZIP_INDEX = zipIndex || {};

        rolesReady = true;

        // ✅ Important: Do NOT show dropdown on load
        hideRoles();
    } catch (e) {
        console.error(e);
        alert("Failed to load data files. Make sure /data/*.json exist and are committed.");
    }
})();
