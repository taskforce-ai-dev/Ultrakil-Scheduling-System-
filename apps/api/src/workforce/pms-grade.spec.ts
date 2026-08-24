import { isPmsGradeLabel, normalizeGradeLabel } from './pms-grade';

describe('normalizeGradeLabel', () => {
  it('upper-cases, strips punctuation and collapses whitespace', () => {
    expect(normalizeGradeLabel('  sr.  pms ')).toBe('SR PMS');
    expect(normalizeGradeLabel('Assistant-PMS')).toBe('ASSISTANT PMS');
  });
});

describe('isPmsGradeLabel', () => {
  it.each([
    'Senior PMS',
    'senior pms',
    'Sr. PMS',
    'PMS',
    'Assistant PMS',
    'Asst PMS',
    'APMS',
    'SPMS',
  ])('recognises %s as a PMS grade', (label) => {
    expect(isPmsGradeLabel(label)).toBe(true);
  });

  // Spellings taken verbatim from the current workforce matrix. Missing any of
  // these would mark a real supervisor as non-supervisory, and jobs they should
  // have covered would land in the Unassigned queue for no reason.
  it.each([
    ['Senoir PMS', 'the workbook\'s spelling of Senior PMS'],
    ['Pest Management Supervisor(PMS)', 'PMS written out in full'],
    ['Assistant PMS', 'Assistant PMS'],
    ['SPMS', 'a stationed supervisor'],
    ['APMS', 'a stationed assistant supervisor'],
  ])('recognises the workbook spelling %s (%s)', (label) => {
    expect(isPmsGradeLabel(label)).toBe(true);
  });

  // Also from the workbook. These are technicians, not supervisors — treating
  // any of them as PMS-grade would let a job pass the supervisor rule without
  // an actual supervisor on the crew.
  it.each([
    'Senior Pest Management Teschnician',
    'Junior Pest Management Teschnician',
    'Pest Management Teschnician(PMT)',
    'Junior PMT',
    'JPMT',
    'JPMT-New',
  ])('does not treat the workbook grade %s as PMS', (label) => {
    expect(isPmsGradeLabel(label)).toBe(false);
  });

  it.each(['Technician', 'Driver', 'Helper', 'Trainee', 'Supervisor'])(
    'does not treat %s as a PMS grade',
    (label) => {
      expect(isPmsGradeLabel(label)).toBe(false);
    },
  );

  it('does not treat Pest Management Executive as a PMS grade', () => {
    // Confirmed by UltraKIL (24 Aug 2026). The executive does not satisfy a
    // job's supervisor requirement — a crew still needs one of the five PMS
    // grades. This test exists so the decision cannot be quietly reversed.
    expect(isPmsGradeLabel('Pest Management Executive')).toBe(false);
  });

  it('does not guess at unknown grades', () => {
    // An unfamiliar grade must not be promoted to supervisor — that would let a
    // job pass the "needs a PMS supervisor" rule without a real supervisor.
    expect(isPmsGradeLabel('Site Manager')).toBe(false);
    expect(isPmsGradeLabel('PMS Trainee')).toBe(false);
  });

  it.each([null, undefined, ''])('handles empty value %p', (label) => {
    expect(isPmsGradeLabel(label)).toBe(false);
  });
});
