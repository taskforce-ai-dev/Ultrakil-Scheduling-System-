/**
 * Reading "this client is no longer serviced" out of a cell's colour.
 *
 * UltraKIL marks dead clients and sites by turning the row red. There is no
 * column that says so, so the colour is the only record — but a workbook is
 * full of red that means nothing of the sort: section headers, weekend bands,
 * overdue-date highlights. Deactivating a live customer because a header above
 * them was red would silently stop their work, and nobody would find out until
 * a technician failed to arrive.
 *
 * So the rule is deliberately narrow. Only the client and site identity cells
 * are ever read, only a red that is unambiguously red counts, and a record
 * whose identity cells disagree is reported for a human to look at rather than
 * being guessed either way.
 */

/** What exceljs hands back for a fill or font colour. */
export interface ExcelColour {
  argb?: string;
  /** A theme colour. Its real RGB lives in the workbook theme, which exceljs
   *  does not resolve, so these are never treated as red. */
  theme?: number;
  indexed?: number;
}

interface Rgb {
  red: number;
  green: number;
  blue: number;
}

/** `FFC00000` and `C00000` both parse; anything else is not a colour we know. */
export function parseArgb(argb: string | undefined): Rgb | null {
  if (!argb) return null;
  const hex = argb.trim().toUpperCase();
  if (!/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(hex) && !/^[0-9A-F]{8}$/.test(hex)) return null;

  const rgb = hex.length === 8 ? hex.slice(2) : hex;
  if (rgb.length !== 6) return null;

  return {
    red: parseInt(rgb.slice(0, 2), 16),
    green: parseInt(rgb.slice(2, 4), 16),
    blue: parseInt(rgb.slice(4, 6), 16),
  };
}

/**
 * True for red and its usual spreadsheet cousins — Excel's own "Bad" pink
 * (FFC7CE), the dark red of the standard palette, hand-picked light reds.
 *
 * The three tests together are what keep orange and yellow out. Red must
 * dominate both other channels, and green and blue must be close to each
 * other: orange (FFC000) fails because green sits far above blue, yellow
 * (FFFF00) fails because green matches red. Getting this wrong in the
 * permissive direction deactivates a paying customer, so the bar is high.
 */
export function isRedMarking(colour: ExcelColour | undefined | null): boolean {
  if (!colour || colour.theme !== undefined || colour.indexed !== undefined) return false;

  const rgb = parseArgb(colour.argb);
  if (!rgb) return false;

  const { red, green, blue } = rgb;
  if (red < 150) return false;
  if (red - green < 40 || red - blue < 40) return false;
  return Math.abs(green - blue) <= 60;
}

/** How a single identity cell is marked. */
export type CellMarking = 'red' | 'plain';

/**
 * The verdict for one record, from the markings of its identity cells.
 *
 * `ambiguous` is the important one: a row whose client cell is red but whose
 * site cell is not may be a dead client, a dead site, or a stray highlight.
 * Rather than pick, it is left active and listed for a manager, because a
 * wrong guess in either direction is worse than a question.
 */
export type RecordMarking = 'inactive' | 'active' | 'ambiguous';

export function classifyRecord(markings: readonly CellMarking[]): RecordMarking {
  const present = markings.filter((marking): marking is CellMarking => marking != null);
  if (present.length === 0) return 'active';

  const red = present.filter((marking) => marking === 'red').length;
  if (red === 0) return 'active';
  if (red === present.length) return 'inactive';
  return 'ambiguous';
}
