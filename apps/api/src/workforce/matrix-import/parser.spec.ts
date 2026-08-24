import { BranchCode } from '@prisma/client';
import { DEFAULT_MAPPING, parseVehicleHeader } from './mapping';
import { buildSourceKey, parseMatrix } from './parser';
import { Grid } from './types';

/**
 * Mirrors the real workbook's shape — a group heading row merged across
 * columns, then the column headers, then a left-margin section label merged
 * down several rows. Names here are invented: the real workbook holds staff
 * data and never enters the repository.
 */
function buildGrid(): Grid {
  return [
    // Group heading row. Merged cells leave the continuation columns blank.
    ['', '', '', '', '', 'Fumigations', '', 'Public Vehicles', 'Personal'],
    // Column header row.
    [
      '',
      'No.',
      'Name Of Technician',
      'Station Location',
      'Designation',
      'MBr Fumigation',
      'Gel Application',
      'Van( 04 People) 253-4289',
      'Motor Bike( 01 Person) BJG 4419',
    ],
    // Colombo section: the label is merged down, so only the first row has it.
    ['Colombo Branch', '1', 'A Perera', '', 'Senoir PMS', '✓', '✓', '✓', ''],
    ['', '2', 'B Silva', '', 'Junior PMT', '', '✓', '', '✓'],
    ['', '3', 'C Fernando', '', 'Assistant PMS', '✓', '', '', ''],
    // Permanently stationed section.
    ['Station Technicians at Serveral Location at permanen', '4', 'D Jayasuriya', 'Lion Brewery', 'APMS', '✓', '✓', '', ''],
    ['', '5', 'E Bandara', 'Unknown Site', 'JPMT', '', '✓', '', ''],
    // Kandy section.
    ['Kandy Branch', '6', 'F Kumara', '', 'Junior PMT', '', '✓', '', ''],
  ];
}

const mapping = {
  ...DEFAULT_MAPPING,
  permanentSiteBranches: { 'Lion Brewery': BranchCode.COLOMBO },
};

describe('parseVehicleHeader', () => {
  it('splits capacity from registration', () => {
    expect(parseVehicleHeader('Van( 04 People) 253-4289')).toEqual({
      code: '253-4289',
      seatCapacity: 4,
    });
  });

  it('handles a single-person vehicle and a space in the registration', () => {
    expect(parseVehicleHeader('Motor Bike( 01 Person) BJG 4419')).toEqual({
      code: 'BJG 4419',
      seatCapacity: 1,
    });
  });

  it('reports no capacity when the header does not give one', () => {
    expect(parseVehicleHeader('Bolero Truck DAC- 2485')).toEqual({
      code: 'Bolero Truck DAC- 2485',
      seatCapacity: null,
    });
  });
});

describe('parseMatrix', () => {
  const result = parseMatrix(buildGrid(), mapping);

  it('finds the header row below the group headings', () => {
    expect(result.headerRowNumber).toBe(2);
  });

  it('separates skill columns from vehicle columns', () => {
    expect(result.skillColumns.map((c) => c.label)).toEqual([
      'MBr Fumigation',
      'Gel Application',
    ]);
    expect(result.vehicleColumns.map((c) => c.label)).toEqual([
      'Van( 04 People) 253-4289',
      'Motor Bike( 01 Person) BJG 4419',
    ]);
  });

  it('reads vehicles with their capacity and ownership group', () => {
    expect(result.vehicles).toEqual([
      {
        code: '253-4289',
        label: 'Van( 04 People) 253-4289',
        seatCapacity: 4,
        ownershipGroup: 'Public Vehicles',
      },
      {
        code: 'BJG 4419',
        label: 'Motor Bike( 01 Person) BJG 4419',
        seatCapacity: 1,
        ownershipGroup: 'Personal',
      },
    ]);
  });

  it('carries the merged section label down to following rows', () => {
    const colombo = result.employees.filter(
      (e) => e.branchCode === BranchCode.COLOMBO && !e.isPermanentlyStationed,
    );
    expect(colombo.map((e) => e.fullName)).toEqual([
      'A Perera',
      'B Silva',
      'C Fernando',
    ]);
  });

  it('assigns the Kandy section to the Kandy branch', () => {
    const kandy = result.employees.find((e) => e.fullName === 'F Kumara');
    expect(kandy?.branchCode).toBe(BranchCode.KANDY);
  });

  it('recognises PMS grades and preserves the source spelling', () => {
    const senior = result.employees.find((e) => e.fullName === 'A Perera');
    expect(senior?.gradeLabel).toBe('Senoir PMS');
    expect(senior?.isPmsGrade).toBe(true);

    const junior = result.employees.find((e) => e.fullName === 'B Silva');
    expect(junior?.isPmsGrade).toBe(false);
  });

  it('reads checkmarks as skills, keeping the workbook wording', () => {
    const perera = result.employees.find((e) => e.fullName === 'A Perera');
    expect(perera?.skills).toEqual([
      { skillCode: 'MBR_FUMIGATION', skillLabel: 'MBr Fumigation' },
      { skillCode: 'GEL_APPLICATION', skillLabel: 'Gel Application' },
    ]);

    const fernando = result.employees.find((e) => e.fullName === 'C Fernando');
    expect(fernando?.skills.map((s) => s.skillCode)).toEqual(['MBR_FUMIGATION']);
  });

  it('reads a vehicle checkmark as an authorization, not ownership', () => {
    const perera = result.employees.find((e) => e.fullName === 'A Perera');
    expect(perera?.vehicles).toEqual([{ vehicleCode: '253-4289' }]);

    const silva = result.employees.find((e) => e.fullName === 'B Silva');
    expect(silva?.vehicles).toEqual([{ vehicleCode: 'BJG 4419' }]);
  });

  it('marks permanently stationed staff with their site', () => {
    const stationed = result.employees.find((e) => e.fullName === 'D Jayasuriya');
    expect(stationed?.isPermanentlyStationed).toBe(true);
    expect(stationed?.permanentSiteName).toBe('Lion Brewery');
    expect(stationed?.branchCode).toBe(BranchCode.COLOMBO);
  });

  it('skips a stationed employee whose site has no confirmed branch', () => {
    expect(result.employees.some((e) => e.fullName === 'E Bandara')).toBe(false);

    const issue = result.issues.find((i) => i.code === 'MATRIX_BRANCH_UNKNOWN');
    expect(issue?.message).toContain('E Bandara');
    expect(issue?.message).toContain('Unknown Site');
  });

  it('reports designations it does not recognise as PMS grades', () => {
    expect(result.unrecognisedGrades).toEqual(['Junior PMT']);
  });

  it('keeps the untouched source row for traceability', () => {
    const perera = result.employees.find((e) => e.fullName === 'A Perera');
    expect(perera?.sourceRow['Designation']).toBe('Senoir PMS');
    expect(perera?.sourceRow['Name Of Technician']).toBe('A Perera');
  });
});

describe('parseMatrix — refusing to guess', () => {
  it('reports a missing header row instead of reading rubbish', () => {
    const result = parseMatrix([['some', 'unrelated', 'sheet']], mapping);
    expect(result.employees).toEqual([]);
    expect(result.issues[0].code).toBe('MATRIX_HEADER_NOT_FOUND');
  });

  it('skips a row with no designation rather than assume a grade', () => {
    const grid = buildGrid();
    grid.push(['', '7', 'G Nolan', '', '', '✓', '', '', '']);

    const result = parseMatrix(grid, mapping);
    expect(result.employees.some((e) => e.fullName === 'G Nolan')).toBe(false);
    expect(
      result.issues.find((i) => i.code === 'MATRIX_ROW_INVALID')?.message,
    ).toContain('G Nolan');
  });

  it('skips a duplicate name in the same branch rather than merging silently', () => {
    const grid = buildGrid();
    grid.push(['Kandy Branch', '8', 'F Kumara', '', 'JPMT', '✓', '', '', '']);

    const result = parseMatrix(grid, mapping);
    expect(result.employees.filter((e) => e.fullName === 'F Kumara')).toHaveLength(1);
    expect(
      result.issues.find((i) => i.code === 'MATRIX_ROW_DUPLICATE')?.message,
    ).toContain('F Kumara');
  });
});

describe('buildSourceKey', () => {
  it('is stable across spacing and casing differences', () => {
    expect(buildSourceKey('A  Perera', BranchCode.COLOMBO)).toBe(
      buildSourceKey('a perera', BranchCode.COLOMBO),
    );
  });

  it('separates the same name in different branches', () => {
    expect(buildSourceKey('A Perera', BranchCode.COLOMBO)).not.toBe(
      buildSourceKey('A Perera', BranchCode.KANDY),
    );
  });
});
