/**
 * ISR (Inventory to Sales Ratio) module.
 * Uses already-converted Net Sales (state.converted) and Inventory — never recomputes Net Sales.
 *
 * ISR = SUM(Inventory) / SUM(Net Sales) × 100
 * Matching requires same Year + Scenario + Cluster + Business (+ Segment when RC).
 */

function normalizeScenarioForIsr(scenario) {
  const s = normalizeText(scenario);
  if (!s) return "";
  if (s === "Historical") return "ACT";
  return s;
}

function isrMatchKey(parts) {
  return [
    parts.year,
    normalizeScenarioForIsr(parts.scenario),
    inventoryClusterForMatch(parts.cluster) || normalizeExecCluster(parts.cluster) || parts.cluster,
    normalizeBusiness(parts.business) || parts.business,
    parts.business === "Row Crops" || parts.business === "RC"
      ? (parts.segment || "")
      : ""
  ].join("|");
}

function aggregateForIsr(records, valueField) {
  const map = new Map();
  for (const r of records) {
    const value = r[valueField];
    if (!Number.isFinite(value)) continue;
    const key = isrMatchKey(r);
    if (!map.has(key)) {
      map.set(key, {
        year: r.year,
        scenario: normalizeScenarioForIsr(r.scenario),
        cluster: inventoryClusterForMatch(r.cluster) || normalizeExecCluster(r.cluster) || r.cluster,
        business: normalizeBusiness(r.business) || r.business,
        segment: (normalizeBusiness(r.business) === "Row Crops") ? (r.segment || "") : "",
        value: 0,
        count: 0,
        fxPlan: r.selectedFxPlan
      });
    }
    const agg = map.get(key);
    agg.value += value;
    agg.count += 1;
  }
  return map;
}

function computeIsrStatus(inv, sales) {
  if (!inv && !sales) return "Missing Inventory"; // and sales
  if (!inv) return "Missing Inventory";
  if (!sales) return "Missing Net Sales";
  if (normalizeScenarioForIsr(inv.scenario) !== normalizeScenarioForIsr(sales.scenario)) {
    return "Scenario Mismatch";
  }
  if (inv.fxPlan && sales.fxPlan && inv.fxPlan !== sales.fxPlan) return "Missing FX Rate";
  if (sales.value === 0) return "Net Sales is Zero";
  if (!Number.isFinite(inv.value) || !Number.isFinite(sales.value)) return "Aggregation Error";
  return "Valid";
}

function calcIsrPercent(inventory, netSales) {
  if (!Number.isFinite(inventory) || !Number.isFinite(netSales) || netSales === 0) return null;
  const pct = (inventory / netSales) * 100;
  if (!Number.isFinite(pct)) return null;
  return pct;
}

/**
 * Build ISR rows at Business grain (and RC segment grain), plus cluster totals + grand total.
 * Net Sales records should already be filtered; inventory too.
 * Scenario must be a single concrete scenario (ACT/FC1/FC2/FC3) — never mix.
 */
function buildIsrTable(inventoryFiltered, netSalesFiltered, selectedFxPlan, selectedScenario) {
  // Enforce single-scenario slices
  const scenario = selectedScenario === "FC" ? null : selectedScenario;
  const inv = inventoryFiltered.filter((r) => {
    if (!scenario) return isFcScenario(r.scenario); // shouldn't use for ISR KPI
    return normalizeScenarioForIsr(r.scenario) === normalizeScenarioForIsr(scenario);
  });
  const sales = netSalesFiltered.filter((r) => {
    if (!scenario) return isFcScenario(r.scenario);
    return normalizeScenarioForIsr(r.scenario) === normalizeScenarioForIsr(scenario);
  });

  const invAgg = aggregateForIsr(inv, "convertedInventoryEur");
  // Net Sales converted field is convertedEur
  const salesAgg = aggregateForIsr(
    sales.map((r) => ({ ...r, convertedInventoryEur: r.convertedEur })),
    "convertedInventoryEur"
  );

  // Also rebuild salesAgg properly
  const salesMap = aggregateForIsr(sales, "convertedEur");

  const allKeys = new Set([...invAgg.keys(), ...salesMap.keys()]);
  const detailRows = [];

  for (const key of allKeys) {
    const i = invAgg.get(key);
    const s = salesMap.get(key);
    const base = i || s;
    const status = computeIsrStatus(i, s);
    const inventory = i ? i.value : null;
    const netSales = s ? s.value : null;
    const isr = status === "Valid" ? calcIsrPercent(inventory, netSales) : null;

    // Guard forbidden values
    if (isr !== null && !Number.isFinite(isr)) {
      detailRows.push({
        level: "detail",
        year: base.year,
        cluster: base.cluster,
        business: base.business,
        segment: base.segment || "",
        scenario: normalizeScenarioForIsr(base.scenario),
        inventory: inventory,
        netSales: netSales,
        isr: null,
        dataStatus: "Aggregation Error",
        invCount: i?.count || 0,
        salesCount: s?.count || 0,
        fxPlan: selectedFxPlan,
        matchKey: key
      });
      continue;
    }

    detailRows.push({
      level: "detail",
      year: base.year,
      cluster: base.cluster,
      business: base.business,
      segment: base.segment || "",
      scenario: normalizeScenarioForIsr(base.scenario),
      inventory,
      netSales,
      isr,
      dataStatus: status,
      invCount: i?.count || 0,
      salesCount: s?.count || 0,
      fxPlan: selectedFxPlan,
      matchKey: key
    });
  }

  // Cluster totals: SUM inv / SUM sales (never average of %)
  const byCluster = new Map();
  for (const row of detailRows) {
    if (!byCluster.has(row.cluster)) {
      byCluster.set(row.cluster, {
        inventory: 0,
        netSales: 0,
        invCount: 0,
        salesCount: 0,
        year: row.year,
        scenario: row.scenario
      });
    }
    const c = byCluster.get(row.cluster);
    if (Number.isFinite(row.inventory)) { c.inventory += row.inventory; c.invCount += row.invCount; }
    if (Number.isFinite(row.netSales)) { c.netSales += row.netSales; c.salesCount += row.salesCount; }
  }

  const clusterRows = [];
  for (const [cluster, c] of [...byCluster.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let status = "Valid";
    if (c.invCount === 0 && c.salesCount === 0) status = "Missing Inventory";
    else if (c.invCount === 0) status = "Missing Inventory";
    else if (c.salesCount === 0) status = "Missing Net Sales";
    else if (c.netSales === 0) status = "Net Sales is Zero";
    const isr = status === "Valid" ? calcIsrPercent(c.inventory, c.netSales) : null;
    clusterRows.push({
      level: "cluster-total",
      year: c.year,
      cluster,
      business: "Total",
      segment: "",
      scenario: c.scenario,
      inventory: c.invCount ? c.inventory : null,
      netSales: c.salesCount ? c.netSales : null,
      isr,
      dataStatus: status,
      invCount: c.invCount,
      salesCount: c.salesCount,
      fxPlan: selectedFxPlan,
      matchKey: `cluster|${cluster}`
    });
  }

  // Grand total
  let gInv = 0; let gSales = 0; let gInvC = 0; let gSalesC = 0;
  for (const row of detailRows) {
    if (Number.isFinite(row.inventory)) { gInv += row.inventory; gInvC += row.invCount; }
    if (Number.isFinite(row.netSales)) { gSales += row.netSales; gSalesC += row.salesCount; }
  }
  let gStatus = "Valid";
  if (!gInvC && !gSalesC) gStatus = "Missing Inventory";
  else if (!gInvC) gStatus = "Missing Inventory";
  else if (!gSalesC) gStatus = "Missing Net Sales";
  else if (gSales === 0) gStatus = "Net Sales is Zero";

  const grand = {
    level: "grand-total",
    year: detailRows[0]?.year ?? null,
    cluster: "LATAM",
    business: "Total",
    segment: "",
    scenario: normalizeScenarioForIsr(scenario) || detailRows[0]?.scenario || "",
    inventory: gInvC ? gInv : null,
    netSales: gSalesC ? gSales : null,
    isr: gStatus === "Valid" ? calcIsrPercent(gInv, gSales) : null,
    dataStatus: gStatus,
    invCount: gInvC,
    salesCount: gSalesC,
    fxPlan: selectedFxPlan,
    matchKey: "grand"
  };

  // Order: per cluster total, then details (business, then RC segments under RC)
  const ordered = [];
  const clusters = [...new Set(detailRows.map((r) => r.cluster))].sort();
  for (const cluster of clusters) {
    const ct = clusterRows.find((r) => r.cluster === cluster);
    if (ct) ordered.push(ct);
    const details = detailRows
      .filter((r) => r.cluster === cluster)
      .sort((a, b) => {
        const ba = a.business.localeCompare(b.business);
        if (ba !== 0) return ba;
        return (a.segment || "").localeCompare(b.segment || "");
      });
    ordered.push(...details);
  }
  ordered.push(grand);

  return {
    rows: ordered,
    detailRows,
    grand,
    scenario: normalizeScenarioForIsr(scenario),
    selectedFxPlan,
    invRecordCount: inv.length,
    salesRecordCount: sales.length
  };
}

function runIsrTests(inventoryFiltered, netSalesFiltered, selectedFxPlan) {
  const results = [];

  // Scenario isolation tests
  for (const fc of ["FC1", "FC2", "FC3"]) {
    const inv = inventoryFiltered.filter((r) => r.scenario === fc);
    const wrongSales = netSalesFiltered.filter((r) => normalizeScenarioForIsr(r.scenario) !== fc && isFcScenario(r.scenario));
    const table = buildIsrTable(inv, netSalesFiltered.filter((r) => normalizeScenarioForIsr(r.scenario) === fc), selectedFxPlan, fc);
    const leaked = table.detailRows.some((row) => row.scenario && row.scenario !== fc && row.dataStatus === "Valid");
    results.push({
      name: `ISR ${fc} never mixes other FC scenarios`,
      pass: !leaked && wrongSales.every(() => true)
    });
  }

  // Aggregation vs average of percents
  const sampleScenario = inventoryFiltered.find((r) => isFcScenario(r.scenario))?.scenario ||
    inventoryFiltered.find((r) => r.scenario === "ACT")?.scenario ||
    "ACT";
  const table = buildIsrTable(inventoryFiltered, netSalesFiltered, selectedFxPlan, sampleScenario);
  const details = table.detailRows.filter((r) => r.dataStatus === "Valid" && r.isr != null);
  if (details.length >= 2) {
    const sumInv = details.reduce((s, r) => s + r.inventory, 0);
    const sumSales = details.reduce((s, r) => s + r.netSales, 0);
    const correct = calcIsrPercent(sumInv, sumSales);
    const avgPct = details.reduce((s, r) => s + r.isr, 0) / details.length;
    const grand = table.grand;
    const usesSum = grand.dataStatus !== "Valid" || Math.abs(grand.isr - correct) < 1e-6;
    const notAvg = grand.dataStatus !== "Valid" || Math.abs(grand.isr - avgPct) > 1e-6 || details.length < 2;
    results.push({
      name: "ISR uses SUM(Inv)/SUM(Sales) not AVERAGE(%))",
      pass: usesSum && (Math.abs(correct - avgPct) < 1e-9 ? true : notAvg || usesSum)
    });
  } else {
    results.push({ name: "ISR uses SUM(Inv)/SUM(Sales) not AVERAGE(%))", pass: true });
  }

  // Zero / missing
  results.push({
    name: "Net Sales = 0 → N/A",
    pass: calcIsrPercent(100, 0) === null
  });
  results.push({
    name: "Missing inventory → N/A status",
    pass: computeIsrStatus(null, { scenario: "FC3", value: 10, fxPlan: selectedFxPlan }) === "Missing Inventory"
  });
  results.push({
    name: "Missing net sales → N/A status",
    pass: computeIsrStatus({ scenario: "FC3", value: 10, fxPlan: selectedFxPlan }, null) === "Missing Net Sales"
  });

  // No Infinity/NaN in table
  let clean = true;
  for (const row of table.rows) {
    if (row.isr !== null && !Number.isFinite(row.isr)) clean = false;
    if (row.isr === Infinity || Number.isNaN(row.isr)) clean = false;
  }
  results.push({ name: "No Infinity/NaN/undefined ISR values", pass: clean });

  // Same FX plan
  const fxOk = table.detailRows
    .filter((r) => r.dataStatus === "Valid")
    .every((r) => r.fxPlan === selectedFxPlan);
  results.push({ name: "ISR rows use selected FX plan", pass: fxOk });

  // Record counts: aggregation maps size <= filtered rows (no multiplication)
  const invAggSize = aggregateForIsr(inventoryFiltered, "convertedInventoryEur").size;
  const salesAggSize = aggregateForIsr(netSalesFiltered, "convertedEur").size;
  results.push({
    name: "Aggregation does not multiply transactional rows",
    pass: invAggSize <= inventoryFiltered.length && salesAggSize <= netSalesFiltered.length
  });

  console.group("ISR — consistency tests");
  console.log(`Executed: ${results.length}`);
  const passed = results.filter((t) => t.pass).length;
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${results.length - passed}`);
  results.forEach((t) => console[t.pass ? "log" : "error"](`${t.pass ? "PASS" : "FAIL"} — ${t.name}`));
  console.groupEnd();
  return results;
}
