/**
 * Weight-export parser. Semicolon-delimited, Date + Weight (kg) columns.
 * Row order is irrelevant and gaps are expected. Unparseable rows are skipped
 * rather than failing the import.
 */
export interface WeightRow {
  day: string;
  kg: number;
}

export function parseWeightCsv(text: string): WeightRow[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift();
  if (!header) throw new Error("Empty CSV");

  const cols = header.split(";").map((h) => h.trim());
  const dateCol = cols.findIndex((h) => /^date$/i.test(h));
  const weightCol = cols.findIndex((h) => /^weight/i.test(h));
  if (dateCol < 0 || weightCol < 0) throw new Error("Need Date and Weight columns");

  const out: WeightRow[] = [];
  for (const line of lines) {
    const cells = line.split(";");
    const day = cells[dateCol]?.trim();
    const kg = Number(cells[weightCol]?.trim());
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !kg || !Number.isFinite(kg)) continue;
    out.push({ day, kg });
  }
  return out;
}
