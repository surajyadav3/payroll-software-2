// Raniwala's salary sheet as a formatted Excel workbook (ExcelJS), outlet
// wise: a Summary sheet (one line per outlet + grand total), an "All Outlets"
// sheet, one sheet per outlet and a "How to read" sheet. Every table sheet has
// a title block, a coloured section band over its columns (Employee, Salary,
// Days, Earnings, Deductions, …), a filter dropdown on each column header,
// frozen header + name columns, rupee number formats and a total row (kept one
// blank row below the data, so filtering never hides it).

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
const ZEBRA_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FC' } };
const THIN = { style: 'thin', color: { argb: 'FFD0D7E2' } };
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const MONEY = '#,##0;[Red]-#,##0;"-"';
const TITLE_ROWS = 3; // title, subtitle, section band — the header is row 4

const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

// Columns that are text, not rupees.
const TEXT_KEYS = new Set([
  'OUTLET', 'EMP CODE', 'EMPLOYEE NAME', 'DIVISION', 'DEPARTMENT', 'DESIGNATION', 'DATE OF JOINING', 'ARREAR REMARK',
  'BANK NAME', 'BANK ACCOUNT NO',
]);
// Counts / percentages — numbers, but not summed as rupees.
const isCountKey = (k) => /DAYS|RETENTION %|\(Y\/N\)|^EMPLOYEES$/.test(k);
const isMoneyKey = (k) => !TEXT_KEYS.has(k) && !isCountKey(k);

const WIDTHS = { 'OUTLET': 22, 'EMP CODE': 10, 'EMPLOYEE NAME': 28, 'DIVISION': 16, 'DEPARTMENT': 18, 'DESIGNATION': 20, 'DATE OF JOINING': 13, 'ARREAR REMARK': 28, 'BANK NAME': 18, 'BANK ACCOUNT NO': 20 };

/** A valid, unique Excel sheet name (31 chars, no []:*?/\). */
function sheetName(name, used) {
  const base = (String(name || 'No outlet').replace(/[[\]:*?/\\]/g, ' ').trim() || 'Sheet').slice(0, 31);
  let n = base;
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
  used.add(n.toLowerCase());
  return n;
}

function titleBlock(ws, colCount, title, subtitle) {
  const last = Math.max(colCount, 6);
  ws.mergeCells(1, 1, 1, last);
  ws.mergeCells(2, 1, 2, last);
  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FF1F3864' } };
  ws.getCell(2, 1).value = subtitle;
  ws.getCell(2, 1).font = { italic: true, size: 10, color: { argb: 'FF595959' } };
  ws.getRow(1).height = 22;
}

/** key -> its section ({ title, color, tint }), for the keys a section lists. */
const sectionMap = (sections) => new Map((sections || []).flatMap((s) => s.keys.map((k) => [k, s])));

function headerRow(ws, keys, sectionOf) {
  const row = ws.getRow(TITLE_ROWS + 1);
  keys.forEach((k, i) => {
    const c = row.getCell(i + 1);
    const s = sectionOf.get(k);
    c.value = k;
    // Under a section band the header takes the section's light tint, so each
    // group of columns reads as one block.
    c.font = { bold: true, color: { argb: s ? 'FF1F1F1F' : 'FFFFFFFF' }, size: 10 };
    c.fill = s ? solid(s.tint) : HEADER_FILL;
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = BOX;
  });
  row.height = 42;
}

/** Row 3: one merged, coloured cell over each run of columns in the same section. */
function sectionBand(ws, keys, sectionOf) {
  let start = 0;
  for (let i = 1; i <= keys.length; i++) {
    const s = sectionOf.get(keys[start]);
    if (i < keys.length && sectionOf.get(keys[i]) === s) continue;
    if (s) {
      if (i - 1 > start) ws.mergeCells(TITLE_ROWS, start + 1, TITLE_ROWS, i);
      const c = ws.getCell(TITLE_ROWS, start + 1);
      c.value = s.title;
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      c.fill = solid(s.color);
      c.alignment = { vertical: 'middle', horizontal: 'center' };
      c.border = BOX;
    }
    start = i;
  }
  ws.getRow(TITLE_ROWS).height = 18;
}

function sumOf(records, key) {
  return records.reduce((t, r) => t + (Number(r[key]) || 0), 0);
}

/** One table sheet: title, section band, header with filters, data, blank row, total row. */
function addTableSheet(wb, name, keys, records, { title, subtitle, unit = 'employees', sections, strongKeys }) {
  const ws = wb.addWorksheet(name, { properties: { defaultRowHeight: 16 } });
  const sectionOf = sectionMap(sections);
  const strong = new Set(strongKeys || []);
  titleBlock(ws, keys.length, title, subtitle);
  sectionBand(ws, keys, sectionOf);
  headerRow(ws, keys, sectionOf);
  ws.columns = keys.map((k) => ({ key: k, width: WIDTHS[k] || Math.min(Math.max(k.length + 2, 11), 16) }));

  records.forEach((rec, i) => {
    const row = ws.getRow(TITLE_ROWS + 2 + i);
    keys.forEach((k, j) => {
      const c = row.getCell(j + 1);
      c.value = rec[k] ?? '';
      c.border = BOX;
      if (i % 2 === 1) c.fill = ZEBRA_FILL;
      if (isMoneyKey(k)) c.numFmt = MONEY;
      if (strong.has(k)) c.font = { bold: true };
      if (k === 'ARREAR REMARK') c.alignment = { wrapText: true, vertical: 'top' };
    });
  });

  const firstData = TITLE_ROWS + 2;
  const lastData = TITLE_ROWS + 1 + records.length;
  // Filter dropdowns on every header cell, over the data rows only.
  ws.autoFilter = { from: { row: TITLE_ROWS + 1, column: 1 }, to: { row: Math.max(lastData, TITLE_ROWS + 1), column: keys.length } };

  // Total row, one blank row below the data so a filter never hides it.
  const total = ws.getRow(lastData + 2);
  keys.forEach((k, j) => {
    const c = total.getCell(j + 1);
    if (j === 0) c.value = `TOTAL · ${records.length} ${records.length === 1 ? unit.replace(/s$/, '') : unit}`;
    else if (k === 'EMPLOYEES') c.value = sumOf(records, k);
    else if (isMoneyKey(k)) {
      const col = ws.getColumn(j + 1).letter;
      c.value = records.length
        ? { formula: `SUBTOTAL(9,${col}${firstData}:${col}${lastData})`, result: sumOf(records, k) }
        : 0;
      c.numFmt = MONEY;
    }
    c.font = { bold: true };
    c.fill = TOTAL_FILL;
    c.border = BOX;
  });

  // Header and the code/name columns stay in view while scrolling.
  const nameCol = keys.indexOf('EMPLOYEE NAME') + 1;
  ws.views = [{ state: 'frozen', ySplit: TITLE_ROWS + 1, xSplit: nameCol > 0 ? nameCol : 0 }];
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${TITLE_ROWS}:${TITLE_ROWS + 1}` };
  return ws;
}

/** "How to read": every column, the section it sits in and what it means. */
function addNotesSheet(wb, name, notes, sections, title) {
  const ws = wb.addWorksheet(name);
  const sectionOf = sectionMap(sections);
  ws.columns = [{ width: 18 }, { width: 34 }, { width: 90 }];
  ws.mergeCells(1, 1, 1, 3);
  ws.getCell(1, 1).value = `${title} — how to read this sheet`;
  ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FF1F3864' } };
  const head = ws.getRow(3);
  ['SECTION', 'COLUMN', 'WHAT IT MEANS'].forEach((h, i) => {
    const c = head.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = HEADER_FILL;
    c.border = BOX;
  });
  notes.forEach(([column, meaning], i) => {
    const s = sectionOf.get(column);
    const row = ws.getRow(4 + i);
    row.getCell(1).value = s?.title || '';
    if (s) {
      row.getCell(1).fill = solid(s.color);
      row.getCell(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    }
    row.getCell(2).value = column;
    row.getCell(2).font = { bold: true };
    row.getCell(3).value = meaning;
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    [1, 2, 3].forEach((n) => { row.getCell(n).border = BOX; });
  });
  ws.views = [{ state: 'frozen', ySplit: 3 }];
}

/**
 * Builds the workbook.
 *   groups    [{ outlet: 'Office Staff', records: [{ 'EMP CODE': …, … }] }]
 *   allRecords  the "All Outlets" sheet's lines, in order (default: every
 *             group's records); `allNote` its subtitle note
 *   title    e.g. 'Raniwala Jewellers — Salary Sheet — September 2026'
 *   subtitle  e.g. 'Draft (not processed) · generated 14 Oct 2026'
 *   sections  [{ title: 'EARNINGS', color, tint, keys: ['BASIC', …] }] — the
 *             column order of every sheet; a key no record has is left out
 *   summaryKeys  rupee columns to total per outlet on the Summary sheet
 *   strongKeys   columns printed in bold (e.g. NET PAY)
 *   notes     [[column, meaning]] for the "How to read" sheet
 */
export function buildSalaryWorkbook(ExcelJS, { groups, allRecords = null, allNote = null, title, subtitle, sections, summaryKeys, strongKeys, notes }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CrewCore HRMS';
  wb.created = new Date();
  const used = new Set();
  const all = groups.flatMap((g) => g.records);
  const present = new Set(all.flatMap((r) => Object.keys(r)));
  const keys = sections.flatMap((s) => s.keys).filter((k) => present.has(k));
  const opts = { sections, strongKeys };

  if (groups.length > 1) {
    // Summary: one line per outlet.
    const sumKeys = ['OUTLET', 'EMPLOYEES', ...summaryKeys];
    const summary = groups.map((g) => ({
      OUTLET: g.outlet,
      EMPLOYEES: g.records.length,
      ...Object.fromEntries(summaryKeys.map((k) => [k, sumOf(g.records, k)])),
    }));
    const ws = addTableSheet(wb, sheetName('Summary', used), sumKeys, summary, { ...opts, title, subtitle: `${subtitle} · outlet-wise totals`, unit: 'outlets' });
    ws.getColumn(1).width = 28;

    addTableSheet(wb, sheetName('All Outlets', used), keys, allRecords || all, { ...opts, title, subtitle: `${subtitle} · ${allNote || 'all outlets (filter the OUTLET column for one)'}` });
  }
  groups.forEach((g) => {
    const outletKeys = groups.length > 1 ? keys.filter((k) => k !== 'OUTLET') : keys;
    addTableSheet(wb, sheetName(g.outlet, used), outletKeys, g.records, { ...opts, title, subtitle: `${subtitle} · ${g.outlet}` });
  });
  if (notes?.length) addNotesSheet(wb, sheetName('How to read', used), notes.filter(([k]) => present.has(k)), sections, title);
  return wb;
}

/** Saves an ExcelJS workbook as a download. */
export async function downloadWorkbook(wb, filename) {
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
