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

  it.each(['Technician', 'Driver', 'Helper', 'Trainee', 'Supervisor'])(
    'does not treat %s as a PMS grade',
    (label) => {
      expect(isPmsGradeLabel(label)).toBe(false);
    },
  );

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
