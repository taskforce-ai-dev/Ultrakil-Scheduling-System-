import { classifyRecord, isRedMarking, parseArgb } from './cell-colour';

describe('parseArgb', () => {
  it('reads both the 8-digit and 6-digit forms exceljs produces', () => {
    expect(parseArgb('FFC00000')).toEqual({ red: 192, green: 0, blue: 0 });
    expect(parseArgb('C00000')).toEqual({ red: 192, green: 0, blue: 0 });
  });

  it('returns null rather than guessing at anything else', () => {
    expect(parseArgb(undefined)).toBeNull();
    expect(parseArgb('')).toBeNull();
    expect(parseArgb('red')).toBeNull();
    expect(parseArgb('FFF')).toBeNull();
  });
});

describe('isRedMarking', () => {
  it.each([
    ['pure red', 'FFFF0000'],
    ["Excel's dark red", 'FFC00000'],
    ["Excel's Bad pink", 'FFFFC7CE'],
    ['a hand-picked light red', 'FFFF9999'],
  ])('treats %s as a deactivation marking', (_label, argb) => {
    expect(isRedMarking({ argb })).toBe(true);
  });

  it.each([
    ['orange', 'FFFFC000'],
    ['yellow', 'FFFFFF00'],
    ['green', 'FF00B050'],
    ['white', 'FFFFFFFF'],
    ['black', 'FF000000'],
    ['grey', 'FF808080'],
  ])('does not treat %s as red', (_label, argb) => {
    expect(isRedMarking({ argb })).toBe(false);
  });

  it('never reads a theme or indexed colour as red', () => {
    // exceljs does not resolve these to RGB. Guessing would mean deactivating
    // a customer on the strength of a number we cannot interpret.
    expect(isRedMarking({ theme: 5 })).toBe(false);
    expect(isRedMarking({ indexed: 10 })).toBe(false);
  });

  it('treats an absent fill as plain', () => {
    expect(isRedMarking(undefined)).toBe(false);
    expect(isRedMarking(null)).toBe(false);
    expect(isRedMarking({})).toBe(false);
  });
});

describe('classifyRecord', () => {
  it('is inactive only when every identity cell agrees', () => {
    expect(classifyRecord(['red', 'red'])).toBe('inactive');
    expect(classifyRecord(['red'])).toBe('inactive');
  });

  it('is active when nothing is red', () => {
    expect(classifyRecord(['plain', 'plain'])).toBe('active');
    expect(classifyRecord([])).toBe('active');
  });

  it('reports disagreement rather than picking a side', () => {
    expect(classifyRecord(['red', 'plain'])).toBe('ambiguous');
    expect(classifyRecord(['plain', 'red'])).toBe('ambiguous');
  });
});
