import { ConfigService } from '@nestjs/config';

import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';
import { ScheduleRunQStashController } from './schedule-run.qstash.controller';
import { ScheduleRunService } from './schedule-run.service';
import { ScheduleRunDispatchService } from './schedule-run-dispatch.service';

const runId = 'e53c9feb-f68f-4c6f-8ba5-31939e3a5000';
const dispatchId = 'ab839d87-6e0d-4b08-a6d1-f3e352a6f4a4';

function fixture() {
  const config = {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string | number> = {
        'scheduleDispatch.executeUrl':
          'https://ultrakil.example.com/api/internal/schedule-runs/execute',
        'scheduleDispatch.failureUrl':
          'https://ultrakil.example.com/api/internal/schedule-runs/failure',
        'scheduleDispatch.reconcileUrl':
          'https://ultrakil.example.com/api/internal/schedule-runs/reconcile',
        'scheduleDispatch.reconciliationCronSecret': 'sixteen-characters',
        'scheduleDispatch.executionBudgetSeconds': 55,
      };
      return values[key];
    }),
    get: jest.fn((key: string) => {
      if (key === 'scheduleDispatch.reconciliationCronSecret') {
        return 'sixteen-characters';
      }
      return undefined;
    }),
  };
  const runs = {
    deliver: jest.fn(async () => ({
      kind: 'completed',
      scheduled: 1,
      unassigned: 0,
    })),
    failForQStash: jest.fn(async () => 'failed'),
  };
  const receiver = { verify: jest.fn(async () => true) };
  const dispatches = { reconcilePending: jest.fn(async () => undefined) };
  const controller = new ScheduleRunQStashController(
    runs as unknown as ScheduleRunService,
    config as unknown as ConfigService,
    receiver,
    dispatches as unknown as ScheduleRunDispatchService,
  );
  const request = (
    raw: string,
    destination = 'execute',
    authorization?: string,
  ) => ({
    rawBody: Buffer.from(raw),
    header: jest.fn((name: string) =>
      name === 'upstash-signature'
        ? 'signature'
        : name === 'authorization'
          ? authorization
          : undefined,
    ),
    destination,
  });
  return { config, runs, receiver, dispatches, controller, request };
}

describe('ScheduleRunQStashController', () => {
  it('uses QStash signatures rather than a browser bearer token', () => {
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        ScheduleRunQStashController.prototype.execute,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        ScheduleRunQStashController.prototype.failure,
      ),
    ).toBe(true);
  });

  it('verifies the exact raw execute body before dispatching the stored run', async () => {
    const f = fixture();
    const raw = JSON.stringify({ runId, dispatchId });

    await expect(
      f.controller.execute(f.request(raw) as never),
    ).resolves.toBeUndefined();

    expect(f.receiver.verify).toHaveBeenCalledWith({
      signature: 'signature',
      body: raw,
      url: 'https://ultrakil.example.com/api/internal/schedule-runs/execute',
    });
    expect(f.runs.deliver).toHaveBeenCalledWith(runId, {
      executionBudgetSeconds: 55,
      retryOnFailure: true,
    });
  });

  it('settles only the run identified by the signed QStash failure callback', async () => {
    const f = fixture();
    const sourceBody = Buffer.from(JSON.stringify({ runId, dispatchId })).toString(
      'base64',
    );
    const raw = JSON.stringify({
      sourceMessageId: 'msg_opaque',
      sourceBody,
      status: 503,
    });

    await expect(
      f.controller.failure(f.request(raw) as never),
    ).resolves.toBeUndefined();

    expect(f.runs.failForQStash).toHaveBeenCalledWith(
      runId,
      dispatchId,
      'msg_opaque',
      'QSTASH_DELIVERY_FAILED',
      'QStash exhausted delivery retries with HTTP 503.',
    );
  });

  it('does not dispatch a parsed payload when its raw-body signature is invalid', async () => {
    const f = fixture();
    f.receiver.verify.mockResolvedValueOnce(false);

    await expect(
      f.controller.execute(
        f.request(JSON.stringify({ runId, dispatchId })) as never,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.runs.deliver).not.toHaveBeenCalled();
  });

  it('keeps an active-lease failure callback retriable after recording it', async () => {
    const f = fixture();
    f.runs.failForQStash.mockResolvedValueOnce('deferred');
    const sourceBody = Buffer.from(JSON.stringify({ runId, dispatchId })).toString(
      'base64',
    );

    await expect(
      f.controller.failure(
        f.request(
          JSON.stringify({
            sourceMessageId: 'msg_opaque',
            sourceBody,
            status: 503,
          }),
        ) as never,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('treats a QStash receiver verification error as an invalid signature', async () => {
    const f = fixture();
    f.receiver.verify.mockRejectedValueOnce(new Error('malformed JWT'));

    await expect(
      f.controller.execute(
        f.request(JSON.stringify({ runId, dispatchId })) as never,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.runs.deliver).not.toHaveBeenCalled();
  });

  it('reconciles durable dispatches from a signed QStash schedule payload', async () => {
    const f = fixture();
    const raw = '{}';

    await expect(
      f.controller.reconcileQStash(f.request(raw) as never),
    ).resolves.toBeUndefined();

    expect(f.receiver.verify).toHaveBeenCalledWith({
      signature: 'signature',
      body: raw,
      url: 'https://ultrakil.example.com/api/internal/schedule-runs/reconcile',
    });
    expect(f.dispatches.reconcilePending).toHaveBeenCalledTimes(1);
  });

  it('accepts only the configured Vercel Cron bearer secret for the daily sweep', async () => {
    const f = fixture();

    await expect(
      f.controller.reconcileVercel(
        f.request('', 'reconcile', 'Bearer incorrect') as never,
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      f.controller.reconcileVercel(
        f.request('', 'reconcile', 'Bearer sixteen-characters') as never,
      ),
    ).resolves.toBeUndefined();

    expect(f.dispatches.reconcilePending).toHaveBeenCalledTimes(1);
  });
});
