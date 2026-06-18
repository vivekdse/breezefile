// extract-table — pull a table off the page into structured JSON.
//
// Extraction runs inside the page (page.evaluate) so it sees the rendered DOM.
// Supports real <table> markup and ARIA grids (role=grid/row/columnheader/cell).
// Per docs/Playwright agent.md it also runs data SANITY checks, not just a
// binary "did we get something" — empty results, ragged rows, and all-blank
// columns surface as warnings/validation so the agent doesn't treat garbage as
// success.
//
//   params = { selector?, max_rows?, headers? }

export async function run(ctx, params) {
  const { page, log, ToolError } = ctx;

  const maxRows = Number(params.max_rows) > 0 ? Number(params.max_rows) : 500;
  const forcedHeaders = params.headers
    ? String(params.headers).split(',').map((h) => h.trim()).filter(Boolean)
    : null;

  log.step(params.selector ? `extracting table: ${params.selector}` : 'extracting largest table on page');

  const extracted = await page.evaluate(
    ({ selector, maxRows, forcedHeaders }) => {
      const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');

      // Pick the target table. Explicit selector wins; otherwise choose the
      // <table> (or role=grid/table) with the most cells — usually the data one.
      function pickTable() {
        if (selector) return document.querySelector(selector);
        const tables = [
          ...document.querySelectorAll('table'),
          ...document.querySelectorAll('[role="grid"], [role="table"]'),
        ];
        let best = null, bestCells = -1;
        for (const t of tables) {
          const cells = t.querySelectorAll('td, th, [role="cell"], [role="columnheader"], [role="gridcell"]').length;
          if (cells > bestCells) { best = t; bestCells = cells; }
        }
        return best;
      }

      const table = pickTable();
      if (!table) return { error: 'no_table' };

      // Rows: real <tr> or role=row.
      let rowEls = [...table.querySelectorAll('tr, [role="row"]')];
      if (!rowEls.length) return { error: 'no_rows' };

      // Headers: forced > <th>/columnheader in first row > first row cells.
      let headers = forcedHeaders;
      let dataStart = 0;
      if (!headers) {
        const headerCells = rowEls[0].querySelectorAll('th, [role="columnheader"]');
        if (headerCells.length) {
          headers = [...headerCells].map(text);
          dataStart = 1;
        } else {
          headers = [...rowEls[0].querySelectorAll('td, [role="cell"], [role="gridcell"]')].map(text);
          dataStart = 1;
        }
      }
      headers = headers.map((h, i) => h || `col_${i + 1}`);

      const rows = [];
      let ragged = 0;
      for (let r = dataStart; r < rowEls.length && rows.length < maxRows; r++) {
        const cells = [...rowEls[r].querySelectorAll('td, th, [role="cell"], [role="gridcell"]')].map(text);
        if (!cells.length) continue;
        if (cells.length !== headers.length) ragged++;
        const obj = {};
        for (let c = 0; c < headers.length; c++) obj[headers[c]] = cells[c] ?? '';
        rows.push(obj);
      }
      return { headers, rows, ragged, total_rows: rowEls.length - dataStart };
    },
    { selector: params.selector || null, maxRows, forcedHeaders },
  );

  if (extracted.error === 'no_table') {
    throw new ctx.ToolError('selector_not_found', params.selector ? `no table matched: ${params.selector}` : 'no table found on the page', {
      action: 'pass --selector',
    });
  }
  if (extracted.error === 'no_rows') {
    throw new ToolError('unexpected_state', 'table found but it has no rows');
  }

  const { headers, rows, ragged, total_rows } = extracted;

  // ── data sanity checks (validation beyond binary success) ──
  const warnings = [];
  const suggestions = [];
  if (!rows.length) {
    throw new ToolError('validation_failed', 'table found but extracted 0 data rows');
  }
  if (ragged > 0) {
    warnings.push(`${ragged} row(s) had a different column count than the header (merged cells?) — values may be misaligned`);
  }
  if (total_rows > rows.length) {
    warnings.push(`truncated to ${rows.length} of ${total_rows} rows (--max_rows). Raise --max_rows for the full set.`);
  }
  // Flag columns that came back entirely empty — often a selector/header mismatch.
  const emptyCols = headers.filter((h) => rows.every((r) => !String(r[h] ?? '').trim()));
  if (emptyCols.length) {
    warnings.push(`columns with no data in any row: ${emptyCols.join(', ')}`);
    suggestions.push('Empty columns usually mean the header row was misdetected — try --headers to set them explicitly.');
  }

  log.ok(`extracted ${rows.length} row(s) × ${headers.length} column(s)`);
  return {
    columns: headers,
    row_count: rows.length,
    rows,
    __validation: {
      table_found: true,
      rows_extracted: rows.length,
      columns: headers.length,
      ragged_rows: ragged,
    },
    __warnings: warnings,
    __suggestions: suggestions,
  };
}
