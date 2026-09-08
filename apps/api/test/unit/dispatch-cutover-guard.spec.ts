import {
  runDispatchCutoverGuard,
} from '../../scripts/dispatch-cutover-guard';

describe('dispatch-provider cutover guard', () => {
  it.each([
    [[]],
    [['--target=redis']],
    [['--target=qstash', '--force']],
  ])(
    'requires one explicit supported target instead of silently defaulting to BullMQ: %p',
    async (args: string[]) => {
      await expect(
        runDispatchCutoverGuard({} as never, args),
      ).rejects.toThrow('--target=qstash or --target=bullmq');
    },
  );

  it('passes without querying the outbox when no run is queued or running', async () => {
    const client = {
      scheduleRun: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    await expect(
      runDispatchCutoverGuard(client as never, ['--target=qstash']),
    ).resolves.toBe('Dispatch cutover guard passed for QSTASH.');
    expect(client.scheduleRun.findMany).toHaveBeenCalledWith({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('rejects active runs on a pre-outbox database without attempting a backfill', async () => {
    const client = {
      scheduleRun: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'run-queued', status: 'QUEUED' },
          { id: 'run-running', status: 'RUNNING' },
        ]),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ outbox_table: null }]),
    };

    await expect(
      runDispatchCutoverGuard(client as never, ['--target=qstash']),
    ).rejects.toThrow(
      '2 schedule run(s) are QUEUED or RUNNING; 2 active run(s) have no dispatch outbox',
    );
  });

  it('rejects a different provider even while the active-run gate is closed', async () => {
    const client = {
      scheduleRun: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'run-queued', status: 'QUEUED' },
        ]),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ outbox_table: 'schedule_run_dispatch_outbox' }]),
      scheduleRunDispatchOutbox: {
        findMany: jest.fn().mockResolvedValue([
          { scheduleRunId: 'run-queued', provider: 'BULLMQ' },
        ]),
      },
    };

    await expect(
      runDispatchCutoverGuard(client as never, ['--target=qstash']),
    ).rejects.toThrow('1 active dispatch outbox row(s) use BULLMQ instead of QSTASH');
    expect(client.scheduleRunDispatchOutbox.findMany).toHaveBeenCalledWith({
      where: { scheduleRunId: { in: ['run-queued'] } },
      select: { scheduleRunId: true, provider: true },
    });
  });

  it('rejects an active run that lacks its outbox after the outbox migration', async () => {
    const client = {
      scheduleRun: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'run-running', status: 'RUNNING' },
        ]),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ outbox_table: 'public.schedule_run_dispatch_outbox' }]),
      scheduleRunDispatchOutbox: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    await expect(
      runDispatchCutoverGuard(client as never, ['--target=bullmq']),
    ).rejects.toThrow('1 active run(s) have no dispatch outbox');
  });
});
