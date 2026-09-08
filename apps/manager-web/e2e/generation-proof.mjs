const fail = () => { throw new Error('Strict generation requires positive preview/confirm additions and newly persisted matching visits.'); };
const fields = ['serviceAgreementId', 'customerName', 'siteName', 'visitDate', 'windowStartMinute',
  'windowEndMinute', 'durationMinutes', 'requiredCrewSize', 'branchCode'];
const key = row => JSON.stringify([row.serviceAgreementId, row.visitDate, row.windowStartMinute]);
function shape(row) {
  if (!row || fields.some(field => row[field] === undefined || row[field] === null)) fail();
  return JSON.stringify(fields.map(field => row[field]));
}
function additions(impact) {
  if (!Array.isArray(impact?.additions) || impact.additions.length === 0) fail();
  const rows = impact.additions.map(shape).sort();
  if (new Set(impact.additions.map(key)).size !== rows.length) fail();
  return rows;
}
export function assertGenerationPreview(preview) {
  if (preview?.isPreview !== true || preview.scheduleRunId !== null) fail();
  additions(preview);
  // This imported active site has no seeded visit. Its first allowed Monday
  // under the fixed rehearsal clock guarantees a real creation opportunity.
  if (!preview.additions.some(row => row.customerName === 'Synthetic Mixed'
    && row.siteName === 'Synthetic Open Colombo' && row.visitDate === '2026-09-07')) fail();
}
export function assertGenerationPersisted(preview, confirmed, before, after) {
  assertGenerationPreview(preview);
  if (confirmed?.isPreview !== false || typeof confirmed.scheduleRunId !== 'string' || !confirmed.scheduleRunId
    || JSON.stringify(additions(preview)) !== JSON.stringify(additions(confirmed))) fail();
  for (const page of [before, after]) {
    if (!Array.isArray(page?.items) || page.total !== page.items.length) fail();
  }
  const previousKeys = new Set(before.items.map(key));
  const previousIds = new Set(before.items.map(row => row.id));
  for (const addition of preview.additions) {
    const persisted = after.items.filter(row => key(row) === key(addition));
    if (previousKeys.has(key(addition)) || persisted.length !== 1
      || typeof persisted[0].id !== 'string' || !persisted[0].id || previousIds.has(persisted[0].id)
      || shape(persisted[0]) !== shape(addition)) fail();
  }
}
