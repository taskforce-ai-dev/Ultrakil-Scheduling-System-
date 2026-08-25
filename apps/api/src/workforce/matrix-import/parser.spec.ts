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

  it('rejects a heading with no registration in it', () => {
    // "Public Vehicles" is a tick column in the real workbook, not a vehicle.
    // Accepting it would create a vehicle record named after a group heading.
    expect(parseVehicleHeader('Public Vehicles')).toEqual({
      code: null,
      seatCapacity: null,
    });
    expect(parseVehicleHeader('Transport')).toEqual({
      code: null,
      seatCapacity: null,
    });
  });
});

describe('the "Public Vehicles" column', () => {
  // Confirmed by UltraKIL: this column means the employee can travel by bus or
  // other public transport. It sits under the same Transport group as the real
  // vehicles, but nobody is "authorised to drive" a bus — so it is a capability
  // on the employee, not a vehicle.
  const grid: Grid = [
    ['', 'No.', 'Name Of Technician', 'Station Location', 'Designation',
      'Transport', 'Transport'],
    ['', 'No.', 'Name Of Technician', 'Station Location', 'Designation',
      'Public Vehicles', 'Van( 04 People) 253-4289'],
    ['Colombo Branch', '1', 'A Perera', '', 'Senoir PMS', '✓', '✓'],
    ['', '2', 'B Silva', '', 'Junior PMT', '', '✓'],
  ];

  const result = parseMatrix(grid, DEFAULT_MAPPING);

  it('is not treated as a vehicle', () => {
    expect(result.vehicles.map((v) => v.code)).toEqual(['253-4289']);
    expect(result.vehicleColumns.map((c) => c.label)).toEqual([
      'Van( 04 People) 253-4289',
    ]);
  });

  it('is not treated as a skill either', () => {
    expect(result.skillColumns).toEqual([]);
  });

  it('is recorded against the employees who are check-marked', () => {
    expect(result.publicTransportColumn?.label).toBe('Public Vehicles');

    const perera = result.employees.find((e) => e.fullName === 'A Perera');
    const silva = result.employees.find((e) => e.fullName === 'B Silva');
    expect(perera?.canUsePublicTransport).toBe(true);
    expect(silva?.canUsePublicTransport).toBe(false);
  });

  it('does not become a driving authorization', () => {
    const perera = result.employees.find((e) => e.fullName === 'A Perera');
    expect(perera?.vehicles).toEqual([{ vehicleCode: '253-4289' }]);
  });

  it('produces no issue, because nothing was skipped', () => {
    expect(result.issues).toEqual([]);
  });
});

describe('a vehicle column that really is unidentifiable', () => {
  const grid: Grid = [
    ['', 'No.', 'Name Of Technician', 'Station Location', 'Designation',
      'Transport', 'Transport'],
    ['', 'No.', 'Name Of Technician', 'Station Location', 'Designation',
      'Spare Van( 04 People)', 'Van( 04 People) 253-4289'],
    ['Colombo Branch', '1', 'A Perera', '', 'Senoir PMS', '✓', '✓'],
  ];

  const result = parseMatrix(grid, DEFAULT_MAPPING);

  it('is skipped, because there is no registration to identify it by', () => {
    expect(result.vehicles.map((v) => v.code)).toEqual(['253-4289']);
  });

  it('says which column it ignored, rather than dropping it silently', () => {
    const issue = result.issues.find(
      (i) => i.code === 'MATRIX_VEHICLE_NO_REGISTRATION',
    );
    expect(issue?.message).toContain('Spare Van');
  });

  it('still authorises the employee for the identifiable vehicle', () => {
    expect(result.employees[0].vehicles).toEqual([{ vehicleCode: '253-4289' }]);
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

describe('a three-row header block, as in the real workbook', () => {
  /**
   * The real matrix stacks its header three rows deep: group names on the
   * first ("Fumigations", "Transport"), a sub-group on the second ("Personal"),
   * and the actual column names on the third. The identity columns are merged
   * down all three, so once merges are resolved they repeat.
   *
   * Reading only the first row named every vehicle column "Transport" — so no
   * vehicle was ever recognised — and treated rows 2 and 3 of the header as an
   * employee called "Name Of Technician".
   */
  const grid: Grid = [
    // Row 1 — identity headers (merged down), group names.
    ['', 'No.', 'Name Of Technician', 'Station Location', 'Designation',
      'Fumigations', 'Fumigations', 'Transport', 'Transport'],
    // Row 2 — identity repeats (merged), vehicle ownership sub-groups.
    ['', 'No.', 'Name Of Technician', 'Station Location', 'Designation',
      '', '', 'Public Vehicles', 'Personal'],
    // Row 3 — identity repeats, the real column names.
    ['', 'No.', 'Name Of Technician', 'Station Location', 'Designation',
      'MBr Fumigation', 'Phosphin Fumigation',
      'Van( 04 People) 253-4289', 'Motor Bike( 01 Person) BJG 4419'],
    // Data.
    ['Colombo Branch', '1', 'A Perera', '', 'Senoir PMS', '✓', '✓', '✓', ''],
    ['', '2', 'B Silva', '', 'Junior PMT', '', '✓', '', '✓'],
  ];

  const result = parseMatrix(grid, DEFAULT_MAPPING);

  it('treats the whole block as header, not as employees', () => {
    expect(result.headerRowNumber).toBe(3);
    expect(result.employees.map((e) => e.fullName)).toEqual([
      'A Perera',
      'B Silva',
    ]);
    expect(
      result.employees.some((e) => e.fullName === 'Name Of Technician'),
    ).toBe(false);
  });

  it('takes each column name from the deepest header row', () => {
    expect(result.skillColumns.map((c) => c.label)).toEqual([
      'MBr Fumigation',
      'Phosphin Fumigation',
    ]);
  });

  it('recognises the vehicle columns that the group row hid', () => {
    expect(result.vehicleColumns.map((c) => c.label)).toEqual([
      'Van( 04 People) 253-4289',
      'Motor Bike( 01 Person) BJG 4419',
    ]);
    expect(result.vehicles.map((v) => [v.code, v.seatCapacity])).toEqual([
      ['253-4289', 4],
      ['BJG 4419', 1],
    ]);
  });

  it('keeps the full group path for each vehicle', () => {
    expect(result.vehicles[0].ownershipGroup).toContain('Transport');
    expect(result.vehicles[0].ownershipGroup).toContain('Public Vehicles');
  });

  it('still reads checkmarks against the right people', () => {
    const perera = result.employees.find((e) => e.fullName === 'A Perera');
    expect(perera?.skills.map((s) => s.skillCode)).toEqual([
      'MBR_FUMIGATION',
      'PHOSPHIN_FUMIGATION',
    ]);
    expect(perera?.vehicles).toEqual([{ vehicleCode: '253-4289' }]);

    const silva = result.employees.find((e) => e.fullName === 'B Silva');
    expect(silva?.vehicles).toEqual([{ vehicleCode: 'BJG 4419' }]);
  });

  it('reports no issues for a well-formed workbook', () => {
    expect(result.issues).toEqual([]);
  });
});

describe('permanently stationed staff use the confirmed site branches', () => {
  // Confirmed by UltraKIL (24 Aug 2026): every stationed site in the current
  // matrix is Colombo. These run against DEFAULT_MAPPING rather than the test
  // mapping, so they fail if the built-in list is ever emptied.
  const stationedGrid = (site: string): Grid => [
    ['', '', '', '', '', 'Fumigations'],
    ['', 'No.', 'Name Of Technician', 'Station Location', 'Designation', 'MBr Fumigation'],
    ['Station Technicians at Serveral Location at permanen', '1', 'Someone', site, 'SPMS', '✓'],
  ];

  it.each([
    'AuseeOats',
    'Wattura resort',
    'Jetwin Blue/Beach',
    'Maththala Airport',
    'Lion Brewery',
    'Logipark International',
  ])('places %s in the Colombo branch', (site) => {
    const result = parseMatrix(stationedGrid(site), DEFAULT_MAPPING);

    expect(result.issues).toEqual([]);
    expect(result.employees).toHaveLength(1);
    expect(result.employees[0].branchCode).toBe(BranchCode.COLOMBO);
    expect(result.employees[0].isPermanentlyStationed).toBe(true);
    expect(result.employees[0].permanentSiteName).toBe(site);
  });

  it('still refuses to guess for a site nobody has confirmed', () => {
    const result = parseMatrix(stationedGrid('Brand New Site'), DEFAULT_MAPPING);

    expect(result.employees).toEqual([]);
    expect(result.issues[0].code).toBe('MATRIX_BRANCH_UNKNOWN');
    expect(result.issues[0].message).toContain('Brand New Site');
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
