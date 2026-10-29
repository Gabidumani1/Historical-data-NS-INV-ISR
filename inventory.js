/**
 * Inventory module — isolated from Net Sales conversion logic.
 * Reuses shared helpers from app.js: parseNumber, normalizeCurrency, isEuroCurrency,
 * normalizeBusiness, getFxRate, resolveFxPlanName, reconstructLocalFromEur,
 * eurAtPlan26ToSelected, classifyCluster, classifyRowCropsSegment, sheetToMatrix, colIndex, etc.
 */

const INVENTORY_FILE = "History_Inventory.xlsx";

function normalizeInventoryCluster(value) {
  const c = normalizeText(value);
  if (!c) return "";
  const key = c.toLowerCase().replace(/\s+/g, " ");
  if (key === "cono sur" || key === "conosur") return "Conosur";
  if (key === "brazil" || key === "brasil") return "Brazil";
  if (key === "norla") return "Norla";
  if (key === "mexico" || key === "paca") return key === "mexico" ? "Mexico" : "PACA";
  return c;
}

/** Map inventory cluster labels onto Net Sales executive clusters for ISR. */
function inventoryClusterForMatch(cluster) {
  return normalizeExecCluster(normalizeInventoryCluster(cluster));
}

function classifyInventoryBusiness(cv5Name, lshFlag, lshDesc, prodH) {
  const excelLike = classifyBusiness(cv5Name, prodH);
  const lsh = `${normalizeText(lshFlag)} ${normalizeText(lshDesc)}`.toUpperCase();
  if (lsh.includes("GLY") || lsh.includes("GLYPHOSATE")) return "Gly";
  return excelLike;
}

function detectInventoryOriginalFxPlan(year, header, matrix, headerRowIdx) {
  // Prefer explicit fx column names
  for (let i = 0; i < header.length; i++) {
    const h = normalizeText(header[i]).toLowerCase();
    if (/fx\s*plan\s*26/.test(h) || h === "fx plan26") return "Plan26";
    if (/fx\s*dec\s*21/.test(h)) return "Dec21";
    if (/fx\s*dec\s*22/.test(h)) return "Dec22";
    if (/fx\s*dec\s*23/.test(h)) return "Dec23";
    if (/fx\s*dec\s*24/.test(h)) return "Dec24";
    if (/fx\s*dec\s*25/.test(h)) return "Dec25";
  }
  // Label rows
  for (let r = 0; r <= headerRowIdx; r++) {
    for (const cell of matrix[r] || []) {
      const t = String(cell ?? "");
      if (/plan\s*26/i.test(t) && /bud|ny|act/i.test(t)) return "Plan26";
      const m = t.match(/fx\s*dec\s*(\d{2})/i);
      if (m) return `Dec${m[1]}`;
    }
  }
  if (year <= 2024) return `Dec${String(year).slice(2)}`;
  return "Plan26";
}

function detectInventoryScenarioColumns(matrix, headerRowIdx, eurCols) {
  const scenarios = [];
  for (const idx of eurCols) {
    let label = null;
    for (let r = Math.max(0, headerRowIdx - 2); r < headerRowIdx; r++) {
      const text = String(matrix[r]?.[idx] ?? "");
      const fc = text.match(/FC\s*\d+/i);
      if (fc) {
        label = fc[0].replace(/\s+/g, "").toUpperCase();
        break;
      }
      if (/ACT/i.test(text) && !/FC/i.test(text)) {
        label = "ACT";
        break;
      }
    }
    if (!label) label = eurCols.length === 1 ? "ACT" : `COL${idx}`;
    scenarios.push({ idx, scenario: label });
  }
  return scenarios;
}

function loadInventoryWorkbook(workbook, countryClusterMap) {
  const yearSheets = workbook.SheetNames.filter((n) => /^\d{4}$/.test(n));
  const records = [];
  const alerts = [];
  const scenariosFound = new Set();

  for (const sheetName of yearSheets) {
    const year = Number(sheetName);
    const matrix = sheetToMatrix(workbook, sheetName);
    if (matrix.length < 5) {
      alerts.push({ level: "warn", message: `Inventory ${sheetName}: insufficient rows.` });
      continue;
    }

    let headerRowIdx = 3;
    for (let i = 0; i < Math.min(8, matrix.length); i++) {
      const joined = (matrix[i] || []).map((c) => String(c ?? "").toLowerCase()).join("|");
      if (joined.includes("currency") && (joined.includes("business") || joined.includes("cluster") || joined.includes("strategic"))) {
        headerRowIdx = i;
        break;
      }
    }
    const header = matrix[headerRowIdx] || [];

    const idxs = {
      cv5Name: colIndex(header, [(h) => /^business group$/i.test(h)]) >= 0
        ? colIndex(header, [(h) => /^business group$/i.test(h)]) + 1 // name often in next col
        : 1,
      currency: colIndex(header, [(h) => /^currency$/i.test(h)]),
      countryGroup: colIndex(header, [(h) => /country group/i.test(h)]),
      sbe: colIndex(header, [(h) => /strategic business entity/i.test(h)]),
      lshFlag: colIndex(header, [(h) => /^lsh flag$/i.test(h)]),
      business: colIndex(header, [(h) => /^business$/i.test(h)]),
      cluster: colIndex(header, [(h) => /^cluster$/i.test(h)]),
      fxCol: colIndex(header, [(h) => /^fx\b/i.test(h)]),
      local: colIndex(header, [(h) => /act lc|local currency/i.test(h)])
    };

    // LSH description often sits next to LSH Flag
    const lshDescIdx = idxs.lshFlag >= 0 ? idxs.lshFlag + 1 : -1;

    const eurCols = header
      .map((h, idx) => ({ h: normalizeText(h), idx }))
      .filter((c) => /^eur$/i.test(c.h))
      .map((c) => c.idx);

    if (idxs.currency < 0 || !eurCols.length) {
      alerts.push({ level: "error", message: `Inventory ${sheetName}: Currency or EUR value column missing.` });
      continue;
    }

    const originalFxPlan = detectInventoryOriginalFxPlan(year, header, matrix, headerRowIdx);
    const scenarioCols = detectInventoryScenarioColumns(matrix, headerRowIdx, eurCols);
    alerts.push({
      level: "ok",
      message: `Inventory ${sheetName}: scenarios [${scenarioCols.map((s) => s.scenario).join(", ")}] · baseline ${originalFxPlan} · EUR stored (reconversion like Net Sales EUR-at-plan).`
    });

    // Month from calendar label e.g. 12.2026 → Dec
    let month = null;
    for (let r = 0; r < headerRowIdx; r++) {
      for (const cell of matrix[r] || []) {
        const m = String(cell ?? "").match(/^(\d{1,2})\.(\d{4})$/);
        if (m) {
          const mi = Number(m[1]) - 1;
          month = MONTH_ORDER[mi] || null;
        }
      }
    }

    for (let r = headerRowIdx + 1; r < matrix.length; r++) {
      const row = matrix[r];
      if (!row || !row.some((c) => c !== null && c !== "")) continue;

      const currency = normalizeCurrency(row[idxs.currency]);
      const excelBusiness = idxs.business >= 0 ? row[idxs.business] : "";
      const excelCluster = idxs.cluster >= 0 ? row[idxs.cluster] : "";
      const cv5Name = row[idxs.cv5Name];
      const lshFlag = idxs.lshFlag >= 0 ? row[idxs.lshFlag] : "";
      const lshDesc = lshDescIdx >= 0 ? row[lshDescIdx] : "";
      const sbe = idxs.sbe >= 0 ? normalizeText(row[idxs.sbe]) : "";
      const countryGroup = idxs.countryGroup >= 0 ? normalizeText(row[idxs.countryGroup]) : "";

      const calcBusiness = classifyInventoryBusiness(cv5Name, lshFlag, lshDesc, "");
      const businessRes = preferExcelOrCalculated(excelBusiness, calcBusiness);
      const business = normalizeBusiness(businessRes.value);

      // Country Group is often already a cluster label (Cono Sur / Brazil / PACA / Mexico)
      const calcCluster = normalizeInventoryCluster(countryGroup) ||
        classifyCluster(countryGroup, countryClusterMap);
      const clusterRes = preferExcelOrCalculated(
        normalizeInventoryCluster(excelCluster),
        calcCluster
      );
      const cluster = normalizeInventoryCluster(clusterRes.value);

      let segment = "";
      if (business === "Row Crops") {
        segment = classifyRowCropsSegment(sbe);
      }

      for (const sc of scenarioCols) {
        scenariosFound.add(sc.scenario);
        const raw = row[sc.idx];
        // Skip entirely empty FC2 cells (null) but keep explicit zeros
        if (raw === null || raw === undefined || raw === "") {
          records.push({
            id: `inv-${year}-${r}-${sc.scenario}`,
            year,
            month,
            business,
            cluster,
            segment,
            currency,
            scenario: sc.scenario,
            originalValueRaw: raw,
            originalValueType: `EUR at ${originalFxPlan}`,
            originalFxPlan,
            country: countryGroup,
            sheet: sheetName,
            rowNumber: r + 1,
            source: "inventory",
            excluded: true,
            error: "Blank inventory value"
          });
          continue;
        }

        records.push({
          id: `inv-${year}-${r}-${sc.scenario}`,
          year,
          month,
          business,
          cluster,
          segment,
          currency,
          scenario: sc.scenario,
          originalValueRaw: raw,
          originalValueType: `EUR at ${originalFxPlan}`,
          originalFxPlan,
          country: countryGroup,
          sheet: sheetName,
          rowNumber: r + 1,
          source: "inventory",
          classificationMeta: {
            businessSource: businessRes.source,
            clusterSource: clusterRes.source
          }
        });
      }
    }
  }

  return {
    records,
    alerts,
    scenarios: [...scenariosFound].sort(),
    dualYears: yearSheets.map(Number).filter((y) => y >= 2026)
  };
}

/**
 * Convert inventory using the same EUR-at-plan / EUR identity rules as Net Sales,
 * via the shared convertRecord() — does not alter Net Sales data.
 *
 * Scale: Inventory source is full EUR; Net Sales is analyzed/displayed in mEUR
 * (values ÷ 1000). Divide Inventory by 1000 after FX so ISR uses the same unit.
 */
const INVENTORY_TO_NET_SALES_SCALE = 1000;

function convertInventoryRecords(rawRecords, selectedFxPlan, fxRates) {
  return rawRecords.map((r) => {
    if (r.excluded && r.error === "Blank inventory value") {
      return {
        ...r,
        originalValue: null,
        selectedFxPlan,
        fxOriginal: null,
        fxSelected: null,
        localCurrencyValue: null,
        convertedEur: null,
        convertedInventoryEur: null,
        convertedInventoryEurFull: null,
        formula: "",
        excluded: true
      };
    }
    const converted = convertRecord(r, selectedFxPlan, fxRates);
    const fullEur = converted.convertedEur;
    const scaledEur = Number.isFinite(fullEur) ? fullEur / INVENTORY_TO_NET_SALES_SCALE : null;
    return {
      ...converted,
      source: "inventory",
      originalInventoryValue: converted.originalValue,
      convertedInventoryEurFull: fullEur,
      // Analytical unit aligned with Net Sales (mEUR)
      convertedInventoryEur: scaledEur,
      convertedEur: scaledEur,
      formula: converted.formula
        ? `${converted.formula} → ÷ ${INVENTORY_TO_NET_SALES_SCALE} (align to Net Sales mEUR)`
        : converted.formula
    };
  });
}

/**
 * @param {object} [options]
 * @param {boolean} [options.chartTrend] Keep prior-year ACT on inventory trend charts when FCn is selected.
 */
function applyInventoryFilters(records, filters, dualYears = [], options = {}) {
  const f = filters;
  const chartTrend = !!options.chartTrend;
  return records.filter((r) => {
    if (r.excluded || !Number.isFinite(r.convertedEur ?? r.convertedInventoryEur)) return false;
    if (f.business.size && !f.business.has(r.business)) return false;
    // Cluster filter: match both raw and executive-normalized labels
    if (f.cluster.size) {
      const raw = r.cluster;
      const exec = inventoryClusterForMatch(raw);
      const ok = [...f.cluster].some((c) => c === raw || c === exec || normalizeExecCluster(c) === exec);
      if (!ok) return false;
    }
    if (f.years.size && !f.years.has(String(r.year))) return false;
    if (f.months.size) {
      if (!r.month || !f.months.has(r.month)) return false;
    }
    const onlyRowCrops = f.business.size > 0 && [...f.business].every((b) => b === "Row Crops");
    const segmentFilterActive = f.segment.size > 0 && (f.business.size === 0 || f.business.has("Row Crops"));
    if (segmentFilterActive) {
      if (r.business === "Row Crops" && !f.segment.has(r.segment)) return false;
      if (onlyRowCrops && r.business !== "Row Crops") return false;
    }

    // Scenario: exact match for dual years; ACT also matches Historical-equivalent inventory ACT for non-dual
    const isDualYear = dualYears.includes(r.year) || r.year >= 2026;
    if (isDualYear) {
      if (f.scenario === "FC") {
        if (!isFcScenario(r.scenario)) return false;
      } else if (f.scenario === "ACT") {
        if (r.scenario !== "ACT") return false;
      } else if (f.scenario) {
        if (r.scenario !== f.scenario) return false;
      }
    } else if (f.scenario && isFcScenario(f.scenario)) {
      if (chartTrend) {
        // Trend chart: keep historical ACT next to selected FCn year
        if (isFcScenario(r.scenario)) return false;
      } else {
        // Tables/ISR: exclude historical ACT when a specific FC is selected
        return false;
      }
    }
    return true;
  });
}

function runInventoryConsistencyTests(rawRecords, fxRates, selectedFxPlan) {
  const results = [];
  const sample = rawRecords.filter((r) => r.currency && !r.excluded).slice(0, 300);

  const eurSamples = sample.filter((r) => isEuroCurrency(r.currency) && parseNumber(r.originalValueRaw).ok);
  let eurPass = true;
  for (const plan of Object.keys(fxRates)) {
    for (const r of eurSamples.slice(0, 40)) {
      const conv = convertRecord(r, plan, fxRates);
      const original = parseNumber(r.originalValueRaw).value;
      if (conv.convertedEur !== original || conv.fxOriginal !== 1 || conv.fxSelected !== 1) {
        eurPass = false;
        break;
      }
    }
    if (!eurPass) break;
  }
  results.push({ name: "Inventory EUR unchanged for any FX plan", pass: eurPass });

  let planSwitchPass = true;
  const plans = Object.keys(fxRates);
  if (plans.length >= 2 && eurSamples.length) {
    const a = convertRecord(eurSamples[0], plans[0], fxRates);
    const b = convertRecord(eurSamples[0], plans[1], fxRates);
    planSwitchPass = a.convertedEur === b.convertedEur;
  }
  results.push({ name: "Changing FX plan does not alter Inventory Currency=EUR", pass: planSwitchPass });

  console.group("Inventory — consistency tests");
  results.forEach((t) => console[t.pass ? "log" : "error"](`${t.pass ? "PASS" : "FAIL"} — ${t.name}`));
  console.groupEnd();
  return results;
}
