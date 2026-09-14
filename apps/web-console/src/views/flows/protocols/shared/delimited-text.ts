export interface TextRow { cells: string[]; line: number }

/** A bounded RFC-style CSV/Excel TSV parser; quoted separators/newlines stay within a cell. */
export function parseRows(text: string, trimCells = true): TextRow[] {
  if (text.length > 65536) throw new Error('点表文本超过 64 Ki 字符，请拆分后导入。');
  const delimiter = text.slice(0, text.indexOf('\n') < 0 ? undefined : text.indexOf('\n')).includes('\t') ? '\t' : ',';
  const rows: TextRow[] = [];
  let cells: string[] = [], cell = '', quoted = false, closedQuote = false;
  let line = 1, rowLine = 1;
  const finishCell = () => { cells.push(trimCells ? cell.trim() : cell); cell = ''; closedQuote = false; };
  const finishRow = () => {
    finishCell();
    if (cells.some((value) => value.trim() !== '')) rows.push({ cells, line: rowLine });
    cells = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; closedQuote = true; }
      } else { cell += char; if (char === '\n') line++; }
      continue;
    }
    if (char === delimiter) { finishCell(); continue; }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      finishRow(); line++; rowLine = line; continue;
    }
    if (closedQuote) {
      if (char === ' ') continue;
      throw new Error(`第 ${line} 行：结束引号后只能出现分隔符或换行。`);
    }
    if (char === '"') {
      if (cell.trim() !== '') throw new Error(`第 ${line} 行：引号只能包住完整单元格。`);
      cell = ''; quoted = true;
    } else cell += char;
  }
  if (quoted) throw new Error(`第 ${rowLine} 行：单元格引号没有闭合。`);
  finishRow();
  return rows;
}

export function conversionNumber(value: string, fallback: number): number | null {
  if (value === '') return fallback;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= 1e12 ? number : null;
}
