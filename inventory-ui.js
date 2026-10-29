/**
 * Inventory + ISR UI wiring. Keeps Net Sales renderers in app.js untouched.
 */

const invUi = {
  search: "",
  sortKey: "year",
  sortDir: "asc",
  page: 1,
  selectedIsrKey: null
};

function formatIsrPct(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A";
  return `${value.toFixed(1)}%`;
}

/**
 * Display only: aligned Inventory (already ÷1000 for ISR) ÷1000 again → mEUR on screen.
 * Does not change stored values or ISR math.
 */
function formatInventorymEUR(scaledValue) {
  if (scaledValue === null || scaledValue === undefined || !Number.isFinite(scaledValue)) return "—";
  const mEur = scaledValue / 1000;
  if (!Number.isFinite(mEur)) return "—";
  // Pivot totals → integers (345, 132…). Detail rows may be <1 → one decimal.
  if (Math.abs(mEur) >= 1) {
    return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(Math.round(mEur));
  }
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(mEur);
}
function formatInventoryKEur(scaledValue) { return formatInventorymEUR(scaledValue); }

function rebuildScenarioChips() {
  const wrap = document.getElementById("filter-scenario");
  if (!wrap) return;
  const fromSales = new Set();
  (state.converted || []).forEach((r) => {
    if (!r.excluded && r.scenario) fromSales.add(normalizeScenarioForIsr(r.scenario));
  });
  const fromInv = new Set(state.inventoryScenarios || []);
  const all = new Set([...fromSales, ...fromInv]);
  // Prefer ACT + sorted FCn
  const list = [];
  if (all.has("ACT") || fromSales.has("Historical")) list.push("ACT");
  [...all].filter((s) => isFcScenario(s)).sort().forEach((s) => list.push(s));
  if (!list.length) list.push("ACT");

  if (!list.includes(state.filters.scenario)) {
    state.filters.scenario = list.includes("ACT") ? "ACT" : list[0];
  }

  wrap.innerHTML = list.map((s) => {
    const cls = s === "ACT" ? "chip chip-act" : "chip chip-fc";
    const active = state.filters.scenario === s ? "active" : "";
    return `<button type="button" class="${cls} ${active}" data-value="${escapeAttr(s)}">${escapeHtml(s)}</button>`;
  }).join("");

  wrap.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      wrap.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      state.filters.scenario = btn.dataset.value;
      refreshDashboard();
    });
  });

  const hint = document.getElementById("scenario-hint");
  if (hint) {
    hint.textContent = `Select one scenario. ISR matches Inventory ${state.filters.scenario} to Net Sales ${state.filters.scenario} only.`;
  }
}

function renderInventoryPivot(filtered) {
  const years = [...new Set(filtered.map((r) => r.year))].sort((a, b) => a - b);
  const fxTag = fxPlanTag(state.filters.fxPlan);
  const elLabel = document.getElementById("inv-fx-label");
  if (elLabel) elLabel.textContent = fxTag;

  const map = new Map();
  for (const r of filtered) {
    const cluster = inventoryClusterForMatch(r.cluster);
    if (!EXEC_CLUSTERS.includes(cluster)) continue;
    const biz = businessShortLabel(r.business);
    if (!EXEC_BUSINESS.includes(biz)) continue;
    const key = `${cluster}|${biz}|${r.year}`;
    map.set(key, (map.get(key) || 0) + (r.convertedInventoryEur ?? r.convertedEur));
  }

  const get = (cluster, biz, year) => map.get(`${cluster}|${biz}|${year}`) || 0;
  let html = `<thead>
    <tr class="fx-row"><th class="corner" colspan="2"></th>${years.map(() => `<th>${escapeHtml(fxTag)}</th>`).join("")}</tr>
    <tr><th class="corner">Inventory (mEUR)</th><th class="corner"></th>${years.map((y) => `<th>${y}</th>`).join("")}</tr>
  </thead><tbody>`;

  for (const cluster of [...EXEC_CLUSTERS, "LATAM"]) {
    const isLatam = cluster === "LATAM";
    const totalFn = (year) => isLatam
      ? EXEC_CLUSTERS.reduce((s, c) => s + EXEC_BUSINESS.reduce((ss, b) => ss + get(c, b, year), 0), 0)
      : EXEC_BUSINESS.reduce((s, b) => s + get(cluster, b, year), 0);
    html += `<tr class="total-row ${isLatam ? "latam-total" : ""}">
      <td class="label-cluster">${cluster}</td><td class="label-line">Total</td>
      ${years.map((y) => `<td class="num">${formatInventorymEUR(totalFn(y))}</td>`).join("")}
    </tr>`;
    for (const biz of EXEC_BUSINESS) {
      const lineFn = (year) => isLatam
        ? EXEC_CLUSTERS.reduce((s, c) => s + get(c, biz, year), 0)
        : get(cluster, biz, year);
      html += `<tr class="data-row">
        <td class="label-cluster">${cluster}</td><td class="label-line">${biz}</td>
        ${years.map((y) => `<td class="num">${formatInventorymEUR(lineFn(y))}</td>`).join("")}
      </tr>`;
    }
  }
  html += "</tbody>";
  const table = document.getElementById("pivot-inventory");
  if (table) table.innerHTML = html;
}

function renderInventoryDetailTable(filtered) {
  let rows = [...filtered];
  const q = invUi.search.trim().toLowerCase();
  if (q) rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
  rows.sort((a, b) => {
    const av = a[invUi.sortKey]; const bv = b[invUi.sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return invUi.sortDir === "asc" ? -1 : 1;
    if (av > bv) return invUi.sortDir === "asc" ? 1 : -1;
    return 0;
  });
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (invUi.page > totalPages) invUi.page = totalPages;
  const start = (invUi.page - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  const countEl = document.getElementById("inv-table-count");
  if (countEl) countEl.textContent = `${rows.length.toLocaleString("en-US")} rows`;
  const info = document.getElementById("inv-page-info");
  if (info) info.textContent = `Page ${invUi.page} of ${totalPages}`;
  const prev = document.getElementById("inv-page-prev");
  const next = document.getElementById("inv-page-next");
  if (prev) prev.disabled = invUi.page <= 1;
  if (next) next.disabled = invUi.page >= totalPages;

  const tbody = document.getElementById("inventory-table-body");
  if (!tbody) return;
  tbody.innerHTML = pageRows.map((r) => {
    const scenarioClass = r.scenario === "ACT" ? "badge-act" : isFcScenario(r.scenario) ? "badge-fc" : "badge-hist";
    return `<tr>
      <td>${r.year}</td>
      <td>${r.month || "—"}</td>
      <td>${escapeHtml(r.business)}</td>
      <td>${escapeHtml(r.cluster)}</td>
      <td>${escapeHtml(r.segment || "—")}</td>
      <td>${escapeHtml(r.currency)}</td>
      <td><span class="badge ${scenarioClass}">${escapeHtml(r.scenario)}</span></td>
      <td>${formatNumber(r.originalValue)}</td>
      <td>${escapeHtml(r.originalValueType)}</td>
      <td>${escapeHtml(r.originalFxPlan || "—")}</td>
      <td>${formatNumber(r.fxOriginal)}</td>
      <td>${formatNumber(r.fxSelected)}</td>
      <td>${formatInventorymEUR(r.convertedInventoryEur ?? r.convertedEur)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="13">No inventory rows for current filters.</td></tr>`;
}

/**
 * Executive ISR pivot — same layout as Inventory / Net Sales:
 * Cluster × Business × Year, cells = ISR %.
 * Totals use SUM(Inv)/SUM(Sales), never average of percentages.
 */
function renderIsrPivot(invFiltered, salesFiltered, scenario) {
  const pivot = document.getElementById("pivot-isr");
  const fxTag = fxPlanTag(state.filters.fxPlan);
  const label = document.getElementById("isr-fx-label");
  if (label) label.textContent = `${fxTag} · ${scenario || ""}`;

  if (!pivot) return;
  if (!scenario || scenario === "FC") {
    pivot.innerHTML = `<tbody><tr><td>Select ACT, FC1, FC2 or FC3 to build the ISR table.</td></tr></tbody>`;
    return;
  }

  const years = [...new Set([
    ...invFiltered.map((r) => r.year),
    ...salesFiltered.map((r) => r.year)
  ])].sort((a, b) => a - b);

  if (!years.length) {
    pivot.innerHTML = `<tbody><tr><td>No overlapping years for scenario ${escapeHtml(scenario)}.</td></tr></tbody>`;
    return;
  }

  const cellMap = new Map(); // cluster|biz|year -> { inv, sales }
  const bump = (cluster, biz, year, invAdd, salesAdd) => {
    const key = `${cluster}|${biz}|${year}`;
    if (!cellMap.has(key)) cellMap.set(key, { inv: 0, sales: 0, hasInv: false, hasSales: false });
    const c = cellMap.get(key);
    if (invAdd != null) { c.inv += invAdd; c.hasInv = true; }
    if (salesAdd != null) { c.sales += salesAdd; c.hasSales = true; }
  };

  for (const r of invFiltered) {
    if (normalizeScenarioForIsr(r.scenario) !== normalizeScenarioForIsr(scenario)) continue;
    const cluster = inventoryClusterForMatch(r.cluster);
    if (!EXEC_CLUSTERS.includes(cluster)) continue;
    const biz = businessShortLabel(r.business);
    if (!EXEC_BUSINESS.includes(biz)) continue;
    const v = r.convertedInventoryEur ?? r.convertedEur;
    if (!Number.isFinite(v)) continue;
    bump(cluster, biz, r.year, v, null);
  }
  for (const r of salesFiltered) {
    if (normalizeScenarioForIsr(r.scenario) !== normalizeScenarioForIsr(scenario)) continue;
    const cluster = normalizeExecCluster(r.cluster);
    if (!EXEC_CLUSTERS.includes(cluster)) continue;
    const biz = businessShortLabel(r.business);
    if (!EXEC_BUSINESS.includes(biz)) continue;
    if (!Number.isFinite(r.convertedEur)) continue;
    bump(cluster, biz, r.year, null, r.convertedEur);
  }

  const cellIsr = (cluster, biz, year) => {
    const c = cellMap.get(`${cluster}|${biz}|${year}`);
    if (!c || !c.hasInv || !c.hasSales) return null;
    return calcIsrPercent(c.inv, c.sales);
  };
  const totalIsr = (clusterOrLatam, year) => {
    let inv = 0; let sales = 0; let hasInv = false; let hasSales = false;
    const clusters = clusterOrLatam === "LATAM" ? EXEC_CLUSTERS : [clusterOrLatam];
    for (const cluster of clusters) {
      for (const biz of EXEC_BUSINESS) {
        const c = cellMap.get(`${cluster}|${biz}|${year}`);
        if (!c) continue;
        if (c.hasInv) { inv += c.inv; hasInv = true; }
        if (c.hasSales) { sales += c.sales; hasSales = true; }
      }
    }
    if (!hasInv || !hasSales) return null;
    return calcIsrPercent(inv, sales);
  };

  let html = `<thead>
    <tr class="fx-row"><th class="corner" colspan="2"></th>${years.map(() => `<th>${escapeHtml(fxTag)}</th>`).join("")}</tr>
    <tr><th class="corner">ISR %</th><th class="corner">${escapeHtml(scenario)}</th>${years.map((y) => `<th>${y}</th>`).join("")}</tr>
  </thead><tbody>`;

  for (const cluster of [...EXEC_CLUSTERS, "LATAM"]) {
    const isLatam = cluster === "LATAM";
    html += `<tr class="total-row ${isLatam ? "latam-total" : ""}">
      <td class="label-cluster">${cluster}</td><td class="label-line">Total</td>
      ${years.map((y) => `<td class="num">${formatIsrPct(totalIsr(isLatam ? "LATAM" : cluster, y))}</td>`).join("")}
    </tr>`;
    for (const biz of EXEC_BUSINESS) {
      html += `<tr class="data-row">
        <td class="label-cluster">${cluster}</td><td class="label-line">${biz}</td>
        ${years.map((y) => {
          const pct = isLatam
            ? (() => {
              let inv = 0; let sales = 0; let hi = false; let hs = false;
              for (const c of EXEC_CLUSTERS) {
                const cell = cellMap.get(`${c}|${biz}|${y}`);
                if (!cell) continue;
                if (cell.hasInv) { inv += cell.inv; hi = true; }
                if (cell.hasSales) { sales += cell.sales; hs = true; }
              }
              return hi && hs ? calcIsrPercent(inv, sales) : null;
            })()
            : cellIsr(cluster, biz, y);
          return `<td class="num">${formatIsrPct(pct)}</td>`;
        }).join("")}
      </tr>`;
    }
  }
  html += "</tbody>";
  pivot.innerHTML = html;
  state.lastIsrPivotYears = years;
}

function renderIsrTable(isrResult) {
  const fxTag = fxPlanTag(state.filters.fxPlan);

  const kpi = document.getElementById("kpi-isr");
  const meta = document.getElementById("kpi-isr-meta");
  if (kpi && meta) {
    if (!isrResult || state.filters.scenario === "FC") {
      kpi.textContent = "—";
      meta.textContent = "Select a single Scenario (ACT / FC1 / FC2 / FC3)";
    } else {
      const g = isrResult.grand;
      kpi.textContent = formatIsrPct(g?.isr);
      meta.textContent = `${g?.year ?? "—"} | ${isrResult.scenario || state.filters.scenario} | ${state.filters.fxPlan || "—"} FX`;
    }
  }

  const table = document.getElementById("isr-table");
  if (!table || !isrResult) {
    if (table) table.innerHTML = `<tbody><tr><td>Load inventory and select a single scenario to compute ISR.</td></tr></tbody>`;
    return;
  }

  let html = `<thead>
    <tr class="fx-row"><th class="corner" colspan="3">ISR detail</th><th colspan="4">${escapeHtml(fxTag)} · ${escapeHtml(isrResult.scenario || "")}</th></tr>
    <tr>
      <th class="corner">Cluster</th><th class="corner">Business</th><th class="corner">Segment</th>
      <th>Inventory (mEUR)</th><th>Net Sales (mEUR)</th><th>ISR %</th><th>Data Status</th>
    </tr>
  </thead><tbody>`;

  for (const row of isrResult.rows) {
    const cls = row.level === "grand-total" || row.level === "cluster-total" ? "total-row" : "data-row";
    const latam = row.level === "grand-total" ? "latam-total" : "";
    const selected = row.matchKey === invUi.selectedIsrKey ? "selected" : "";
    html += `<tr class="${cls} ${latam} ${selected}" data-isr-key="${escapeAttr(row.matchKey)}">
      <td class="label-cluster">${escapeHtml(row.cluster)}</td>
      <td>${escapeHtml(row.business)}</td>
      <td>${escapeHtml(row.segment || "—")}</td>
      <td class="num">${row.inventory == null ? "—" : formatInventorymEUR(row.inventory)}</td>
      <td class="num">${row.netSales == null ? "—" : formatmEUR(row.netSales)}</td>
      <td class="num"><strong>${formatIsrPct(row.isr)}</strong></td>
      <td>${escapeHtml(row.dataStatus)}</td>
    </tr>`;
  }
  html += "</tbody>";
  table.innerHTML = html;

  table.querySelectorAll("tr[data-isr-key]").forEach((tr) => {
    tr.addEventListener("click", () => {
      invUi.selectedIsrKey = tr.dataset.isrKey;
      const row = isrResult.rows.find((r) => r.matchKey === invUi.selectedIsrKey);
      renderIsrAudit(row, isrResult);
      renderIsrTable(isrResult);
    });
  });
}

function renderIsrAudit(row, isrResult) {
  const body = document.getElementById("isr-audit-body");
  if (!body) return;
  if (!row) {
    body.innerHTML = `<p class="empty-state">No ISR row selected.</p>`;
    return;
  }
  const inv = row.inventory;
  const sales = row.netSales;
  const formula = (inv != null && sales != null && sales !== 0)
    ? `${formatInventorymEUR(inv)} / ${formatmEUR(sales)} × 100 = ${formatIsrPct(row.isr)}`
    : "N/A";
  body.innerHTML = `
    <div class="audit-grid">
      <div class="audit-item"><span>Year</span><strong>${row.year ?? "—"}</strong></div>
      <div class="audit-item"><span>Cluster</span><strong>${escapeHtml(row.cluster)}</strong></div>
      <div class="audit-item"><span>Business</span><strong>${escapeHtml(row.business)}</strong></div>
      <div class="audit-item"><span>Segment</span><strong>${escapeHtml(row.segment || "—")}</strong></div>
      <div class="audit-item"><span>Scenario (Inventory)</span><strong>${escapeHtml(row.scenario)}</strong></div>
      <div class="audit-item"><span>Scenario (Net Sales)</span><strong>${escapeHtml(row.scenario)}</strong></div>
      <div class="audit-item"><span>FX Plan</span><strong>${escapeHtml(row.fxPlan || "")}</strong></div>
      <div class="audit-item"><span>Data Status</span><strong>${escapeHtml(row.dataStatus)}</strong></div>
      <div class="audit-item"><span>Inventory (mEUR aligned)</span><strong>${inv == null ? "—" : formatInventorymEUR(inv)}</strong></div>
      <div class="audit-item"><span>Net Sales (mEUR)</span><strong>${sales == null ? "—" : formatmEUR(sales)}</strong></div>
      <div class="audit-item"><span>Inventory records</span><strong>${row.invCount}</strong></div>
      <div class="audit-item"><span>Net Sales records</span><strong>${row.salesCount}</strong></div>
    </div>
    <div class="formula-box">${escapeHtml(formula)}</div>
    <p class="hint">Matching status: ${row.dataStatus === "Valid" ? "OK — same Year / Scenario / Cluster / Business" : escapeHtml(row.dataStatus)}. Filtered Inventory rows: ${isrResult.invRecordCount}; Net Sales rows: ${isrResult.salesRecordCount}.</p>
  `;
}

/** Chart display: aligned inventory ÷ 1000 → same mEUR as pivot (ISR unchanged). */
function toInventoryChartMEUR(alignedValue) {
  return Number.isFinite(alignedValue) ? alignedValue / 1000 : 0;
}

function updateInventoryHistoryChart(_filteredIgnored) {
  const ctx = document.getElementById("chart-inventory");
  if (!ctx || typeof Chart === "undefined") return;

  const dualYears = state.inventoryDualYears || state.dualYears || [];
  // Trend chart: with FCn selected, still show prior-year ACT bars
  const filtered = applyInventoryFilters(
    state.inventoryConverted || [],
    state.filters,
    dualYears,
    { chartTrend: true }
  );
  const mode = state.ui.inventoryHistoryMode || "Total";
  const years = [...new Set(filtered.map((r) => r.year))].sort((a, b) => a - b);
  const labels = years.map((y) => chartYearAxisLabel(y, dualYears));
  const stacked = mode !== "Total";
  let datasets = [];

  if (!years.length) {
    if (state.charts.inventory) {
      state.charts.inventory.destroy();
      state.charts.inventory = null;
    }
    return;
  }

  if (mode === "Total") {
    datasets = [{
      label: "Inventory (mEUR)",
      data: years.map((y) => toInventoryChartMEUR(
        filtered.filter((r) => r.year === y).reduce((s, r) => s + (r.convertedInventoryEur ?? r.convertedEur ?? 0), 0)
      )),
      backgroundColor: "#00BCFF",
      borderRadius: 8
    }];
  } else {
    const keyFn = mode === "Business"
      ? (r) => businessShortLabel(r.business) || r.business || "Unknown"
      : (r) => inventoryClusterForMatch(r.cluster) || r.cluster || "Unknown";
    const seriesKeys = [...new Set(filtered.map(keyFn).filter(Boolean))].sort();
    datasets = seriesKeys.map((key) => ({
      label: key,
      data: years.map((y) => toInventoryChartMEUR(
        filtered.filter((r) => r.year === y && keyFn(r) === key)
          .reduce((s, r) => s + (r.convertedInventoryEur ?? r.convertedEur ?? 0), 0)
      )),
      backgroundColor: colorFor(key, mode),
      borderRadius: 6,
      stack: "s"
    }));
  }

  if (state.charts.inventory) state.charts.inventory.destroy();
  state.charts.inventory = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 24 } },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: mode !== "Total", position: "bottom" },
        ...chartLabelPluginOptions(stacked),
        tooltip: {
          callbacks: {
            label(c) {
              const fx = state.filters.fxPlan;
              const n = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(Math.round(c.parsed.y || 0));
              return `${c.dataset.label}: ${n} mEUR | FX ${fx}`;
            }
          }
        }
      },
      scales: {
        x: { stacked, grid: { display: false } },
        y: {
          stacked,
          title: { display: true, text: "mEUR" },
          ticks: {
            callback: (v) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(v)
          }
        }
      }
    }
  });
}

function refreshInventoryAndIsr() {
  if (!state.inventoryConverted?.length) {
    const pivot = document.getElementById("pivot-isr");
    if (pivot) pivot.innerHTML = `<tbody><tr><td>Load History_Inventory.xlsx to compute ISR.</td></tr></tbody>`;
    renderIsrTable(null);
    if (state.charts.inventory) {
      state.charts.inventory.destroy();
      state.charts.inventory = null;
    }
    return;
  }
  rebuildScenarioChips();

  const invFiltered = applyInventoryFilters(
    state.inventoryConverted,
    state.filters,
    state.inventoryDualYears || state.dualYears || []
  );
  renderInventoryPivot(invFiltered);
  renderInventoryDetailTable(invFiltered);
  updateInventoryHistoryChart(invFiltered);

  const salesFiltered = getFilteredRecords();
  const scenario = state.filters.scenario;
  if (!scenario || scenario === "FC") {
    renderIsrPivot([], [], scenario);
    renderIsrTable(null);
    return;
  }

  renderIsrPivot(invFiltered, salesFiltered, scenario);
  const isrResult = buildIsrTable(invFiltered, salesFiltered, state.filters.fxPlan, scenario);
  state.lastIsrResult = isrResult;
  renderIsrTable(isrResult);

  const tests = runIsrTests(invFiltered, salesFiltered, state.filters.fxPlan);
  // Append ISR test summary into alert list lightly
  const list = document.getElementById("alert-list");
  if (list && tests?.length) {
    const failed = tests.filter((t) => !t.pass).length;
    const div = document.createElement("div");
    div.className = `alert-item ${failed ? "error" : "ok"}`;
    div.textContent = `ISR tests: ${tests.length - failed}/${tests.length} passed`;
    list.prepend(div);
  }
}

function exportInventoryCsv() {
  const rows = applyInventoryFilters(state.inventoryConverted || [], state.filters, state.inventoryDualYears || []);
  const headers = ["Year","Month","Business","Cluster","Segment","Currency","Scenario","Original Inventory Value","Original Value Type","Original FX Plan","FX Original","FX Selected","Converted Inventory EUR"];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push([
      r.year, r.month || "", r.business, r.cluster, r.segment || "", r.currency, r.scenario,
      r.originalValue, r.originalValueType, r.originalFxPlan || "", r.fxOriginal, r.fxSelected,
      r.convertedInventoryEur ?? r.convertedEur
    ].map(csvEscape).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `inventory_${state.filters.fxPlan || "fx"}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportIsrCsv() {
  const rows = state.lastIsrResult?.rows || [];
  const headers = ["Level","Year","Cluster","Business","Segment","Scenario","Inventory","Net Sales","ISR %","Data Status","Inv Records","Sales Records","FX Plan"];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push([
      r.level, r.year, r.cluster, r.business, r.segment || "", r.scenario,
      r.inventory, r.netSales, r.isr == null ? "N/A" : r.isr, r.dataStatus,
      r.invCount, r.salesCount, r.fxPlan
    ].map(csvEscape).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `isr_${state.filters.scenario || "sc"}_${state.filters.fxPlan || "fx"}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function bindInventoryUiEvents() {
  document.getElementById("btn-export-inventory")?.addEventListener("click", exportInventoryCsv);
  document.getElementById("btn-export-isr")?.addEventListener("click", exportIsrCsv);
  document.getElementById("inv-table-search")?.addEventListener("input", (e) => {
    invUi.search = e.target.value;
    invUi.page = 1;
    refreshInventoryAndIsr();
  });
  document.getElementById("inv-page-prev")?.addEventListener("click", () => {
    invUi.page -= 1;
    refreshInventoryAndIsr();
  });
  document.getElementById("inv-page-next")?.addEventListener("click", () => {
    invUi.page += 1;
    refreshInventoryAndIsr();
  });
  document.querySelectorAll("#inventory-detail-table th[data-inv-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.invSort;
      if (invUi.sortKey === key) invUi.sortDir = invUi.sortDir === "asc" ? "desc" : "asc";
      else { invUi.sortKey = key; invUi.sortDir = "asc"; }
      refreshInventoryAndIsr();
    });
  });
  document.querySelectorAll("#inventory-history-breakdown .seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#inventory-history-breakdown .seg").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      state.ui.inventoryHistoryMode = btn.dataset.mode;
      refreshInventoryAndIsr();
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindInventoryUiEvents();
});
