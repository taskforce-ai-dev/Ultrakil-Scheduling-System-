export type PublishReadiness = {
  state: 'READY' | 'BLOCKED' | 'ACKNOWLEDGEMENT_REQUIRED';
  code: 'ZERO_RESULTS' | 'PARTIAL_RESULTS' | null;
  message: string | null;
};

export function publishReadiness(counters: { visitsConsidered: number; visitsScheduled: number; visitsUnassigned: number }): PublishReadiness {
  if (counters.visitsScheduled <= 0) return { state: 'BLOCKED', code: 'ZERO_RESULTS', message: 'This run produced no dispatchable assignments and cannot be published.' };
  if (counters.visitsUnassigned > 0 || counters.visitsScheduled < counters.visitsConsidered) return { state: 'ACKNOWLEDGEMENT_REQUIRED', code: 'PARTIAL_RESULTS', message: 'This run left visits unassigned. A manager acknowledgement and reason are required to publish the partial schedule.' };
  return { state: 'READY', code: null, message: null };
}
