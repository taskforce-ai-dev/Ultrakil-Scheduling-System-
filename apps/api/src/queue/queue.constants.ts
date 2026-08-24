/**
 * BullMQ queue names.
 *
 * Phase 1 registers the queues and proves the connection is healthy. The
 * producers and workers land with visit generation (ULK-C04) and the optimizer
 * (ULK-C06); the names are fixed now so nothing has to be renamed later.
 */
export const QUEUE_VISIT_GENERATION = 'visit-generation';
export const QUEUE_SCHEDULE_RUN = 'schedule-run';

export const ALL_QUEUES = [QUEUE_VISIT_GENERATION, QUEUE_SCHEDULE_RUN] as const;
