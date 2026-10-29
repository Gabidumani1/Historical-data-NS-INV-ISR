# Net Sales FX Analyzer

Local browser tool to analyze CS LATAM **Net Sales (2021–2026)** on a **common FX plan**, so yearly figures become comparable in EUR.

## How to run

1. Open a terminal in this folder.
2. Start a local server (required for automatic file loading):

```bash
python -m http.server 8080
```

3. Open [http://localhost:8080](http://localhost:8080).

Alternatively, open `index.html` and use the file pickers to select:

- `History_Net Sales.xlsx`
- `fx rates.xlsx`

> Opening via `file://` cannot auto-fetch the Excel files due to browser security. Use the local server or the file inputs.

## Files used

| File | Role |
|------|------|
| `History_Net Sales.xlsx` | Historical Net Sales by year sheet (`2021`…`2026`) |
| `fx rates.xlsx` | FX plans / rates (`fx_rate` sheet) |
| `index.html` / `styles.css` / `app.js` | Application |

The embedded `fx_rate` sheet inside `History_Net Sales.xlsx` is **not** used. The dedicated `fx rates.xlsx` is the source of truth.

## Column mapping (from inspected files)

### History_Net Sales.xlsx

| Logical field | Source column / rule |
|---------------|----------------------|
| Year | Sheet name (`2021`…`2026`) |
| Month | `Posting period` (2025–2026 only; 2021–2024 are annual) |
| Business | `Business` (`RC` normalized to **Row Crops**) |
| Cluster | `Cluster` |
| Row Crops Segment | `Business Classification` (`Soybean`, `Corn`, `Other Seeds` when Business = RC) |
| Currency | `Currency key` |
| Value 2021–2024 | `* 1.000` → treated as **local currency** |
| Value 2025 | `* 1.000 EUR` → **EUR at Plan26** |
| Value 2026 ACT | First `* 1.000 EUR` under label `ACT@PLAN CY QTD/YTD` |
| Value 2026 FC# | Second `* 1.000 EUR` under label `FC3@PLAN CY QTD/YTD` → scenario **FC3** |

### fx rates.xlsx

| Logical field | Source |
|---------------|--------|
| Currency | `Currency` |
| FX plans | `Dec21`, `Dec22`, `Dec23`, `Dec24`, `Dec25`, `Plan26`, `FC126`, `FC226`, `FC326`, `PLAN27` |

Rates are **local currency units per 1 EUR** (example: BRL Plan26 ≈ 6.64). Confirmed against BRL/ARS/MXN magnitudes.

## Conversion formulas

Centralized in `app.js` (`localPerEurToEur`, `eurAtPlan26ToSelected`).

### Priority rule — Currency = EUR (all years)

```
Converted EUR = Original Value
FX Original = 1
FX Selected = 1
```

No FX plan change can alter EUR rows.

### 2021–2024 (local currency)

```
Converted EUR = Local Value / Selected FX
```

### 2025–2026 (EUR originally at Plan26)

```
Local reconstructed = Original EUR × Plan26 FX
Converted EUR = Local reconstructed / Selected FX
# equivalent:
Converted EUR = Original EUR × Plan26 FX / Selected FX
```

Selecting **Plan26** for 2025/2026 returns the original EUR value (identity check).

## Divergences vs prompt assumptions

| Assumption in prompt | Actual file content |
|----------------------|---------------------|
| Business = `Row Crops` | Stored as `RC` (normalized in UI to Row Crops) |
| Cluster includes only Brazil / Conosur / Norla | 2021–2024 also have `PACA` and `Mexico` |
| FC# generic name | 2026 forecast column is **FC3** |
| Monthly history for all years | Months only in 2025–2026 |
| EUR present in FX file | **EUR is absent** → forced to rate `1` |
| ACT / FC without overlap | **Overlap exists** across many 2026 months — tool keeps scenarios separated and warns |
| Values unit | Kept exactly as stored in Excel cells (header label `* 1.000` retained as metadata only) |

## Limitations

- Month filters apply only to sheets that contain `Posting period`.
- ACT + FCn must not be summed into a single annual total (Scenario toggle keeps them exclusive).
- Some rows may be incomplete (null currency/cluster) and are excluded with an explicit reason.
- Zero FX rates for unused currencies are flagged; LATAM currencies used in Net Sales are covered.
- Pre-computed `@plan27` helper columns in history sheets are ignored; conversion always uses `fx rates.xlsx`.

## Sustainability / future years

The loader detects sheet **structure**, not fixed year numbers:

| Detected layout | Behavior |
|-----------------|----------|
| Local `* 1.000` (no EUR) | Convert local ÷ selected FX |
| Single `* 1.000 EUR` | Treat as EUR at baseline plan (e.g. Plan26) |
| ACT + FCn EUR columns | Dual scenario; UI shows the real label (FC1/FC2/FC3) |

So adding a `2027` tab should work as long as columns follow one of these patterns. When `2026` later becomes a single EUR column (like today’s `2025`), it will automatically switch to single-scenario mode.

Still verify after major file redesigns: new FX plan names must exist in `fx rates.xlsx`, and baseline plan labels (Plan26/Plan27) should remain discoverable in headers or FX file.

## Business / Cluster / Segment classification

Hybrid rule: **use Excel value when the cell is filled; otherwise calculate**.

### Cluster
1. Look up `Country final-dest.` in sheet `De-para`
2. If missing: Brazil → Brazil; Argentina/Uruguay/Chile/Peru/Paraguay/Bolivia → Conosur; **everything else → Norla**

### Business
1. `CV 5 Business Group` = Crop Protection **and** `ProdH` contains Glyphosate → **Gly**
2. Other Crop Protection → **CP-Core**
3. Everything else → **Row Crops**

### Row Crops segment (`Business Classification`)
1. SBE contains Soybean → **Soybean**
2. SBE contains Corn → **Corn**
3. Else → **Other Seeds**

For 2027+, source extracts can omit the helper formula columns (`Business`, `Cluster`, `Business Classification`) as long as Country, CV5, ProdH, SBE, Currency and values are present.

## Libraries

- [SheetJS (xlsx)](https://cdn.sheetjs.com/) — Excel reading
- [Chart.js 4](https://www.chartjs.org/) — charts
- Google Fonts: IBM Plex Sans / DM Sans

## Consistency tests

On each load / FX change, the app runs automated checks and prints a PASS/FAIL summary to the browser console, including:

- EUR rows unchanged under any FX plan
- 2021–2024 = local / selected FX
- 2025–2026 = original × Plan26 / selected FX
- Plan26 identity for 2025–2026
- Record count preserved after FX join

## Inventory + ISR (extension)

### Files

| File | Role |
|------|------|
| `History_Inventory.xlsx` | Inventory history (year sheets `2021`…`2026`) |
| `inventory.js` | Load / normalize / convert Inventory |
| `isr.js` | ISR aggregation + matching + tests |
| `inventory-ui.js` | Inventory & ISR tables / KPI |

Net Sales logic in `app.js` is reused as the ISR denominator — not recalculated.

### Inventory column mapping

| Logical field | Source |
|---------------|--------|
| Year | Sheet name |
| Month | Calendar label `MM.YYYY` (typically December snapshot) |
| Currency | `Currency` |
| Business | Excel `Business` if filled; else from Business Group + LSH (Glyphosate → Gly, Crop Protection → CP-Core, else Row Crops) |
| Cluster | Excel `Cluster` if filled; else `Country Group` normalized (`Cono Sur` → Conosur; Mexico/PACA kept / mapped to Norla for ISR) |
| Row Crops Segment | From SBE (Soybean / Corn / Other Seeds) when Business = Row Crops |
| Value 2021–2024 | Column `EUR` · original type **EUR at Dec{YY}** (also `act LC` + `fx decYY`; LC = EUR × FX) |
| Value 2025 | Column `EUR` · **EUR at Plan26** (`fx plan26`) |
| Value 2026 | Wide `EUR` columns labeled `FC1@BUD`, `FC2@BUD`, `FC3@BUD` → long Scenario FC1/FC2/FC3 · **EUR at Plan26** |

PIVOT sheets are ignored.

### Inventory FX methodology

Values are stored in **EUR** at a baseline plan (DecYY or Plan26), not as raw local-only amounts.

Conversion to the selected FX plan reuses the same shared rule as Net Sales EUR-at-plan years:

`Converted = Original EUR × Baseline FX / Selected FX`

`Currency = EUR` → never converted (FX = 1).

### ISR

`ISR % = SUM(Inventory EUR) / SUM(Net Sales EUR) × 100`

Matching dimensions: Year + Scenario + Cluster + Business (+ RC Segment).

**Hard rule:** FC1 only with FC1, FC2 only with FC2, FC3 only with FC3. Totals never average percentages.

Note: Inventory 2026 has FC1/FC2/FC3 (no ACT). Net Sales 2026 has ACT + FC3. Select **FC3** to compare both sides for 2026.

### Inventory scale alignment

Inventory source values are full EUR. Net Sales is viewed in **mEUR** (÷ 1000).

After FX conversion, Inventory is divided by **1000** before ISR and Inventory analytics:

`Converted Inventory (aligned) = Inventory EUR / 1000`

Net Sales figures are **not** changed. ISR = aligned Inventory / Net Sales × 100.
