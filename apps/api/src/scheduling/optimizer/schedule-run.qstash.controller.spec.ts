import { ConfigService } from '@nestjs/config';

import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';
import { ScheduleRunQStashController } from './schedule-run.qstash.controller';
import { ScheduleRunService } from './schedule-run.service';

const runId = 'e53c9feb-f68f-4c6f-8ba5-31939e3a5000';

function fixture() {
  const config = {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string | number> = {
        'scheduleDispatch.executeUrl':
          'https://ultrakil.example.com/api/internal/schedule-runs/execute',
        'scheduleDispatch.failureUrl':
          'https://ultrakil.example.com/api/internal/schedule-runs/failure',
        'scheduleDispatch.executionBudgetSeconds': 240,
      };
      return values[key];
    }),
  };
  const runs = {
    deliver: jest.fn(async () => ({
      kind: 'completed',
      scheduled: 1,
      unassigned: 0,
    })),
    failForQStash: jest.fn(async () => undefined),
  };
  const receiver = { verify: jest.fn(async () => true) };
  const controller = new ScheduleRunQStashController(
    runs as unknown as ScheduleRunService,
    config as unknown as ConfigService,
    receiver,
  );
  const request = (raw: string, destination = 'execute') => ({
    rawBody: Buffer.from(raw),
    header: jest.fn((name: string) =>
      name === 'upstash-signature' ? 'signature' : undefined,
    ),
    destination,
  });
  return { config, runs, receiver, controller, request };
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
    const raw = JSON.stringify({ runId });

    await expect(
      f.controller.execute(f.request(raw) as never),
    ).resolves.toBeUndefined();

    expect(f.receiver.verify).toHaveBeenCalledWith({
      signature: 'signature',
      body: raw,
      url: 'https://ultrakil.example.com/api/internal/schedule-runs/execute',
    });
    expect(f.runs.deliver).toHaveBeenCalledWith(runId, {
      executionBudgetSeconds: 240,
      retryOnFailure: true,
    });
  });

  it('settles only the run identified by the signed QStash failure callback', async () => {
    const f = fixture();
    const sourceBody = Buffer.from(JSON.stringify({ runId })).toString(
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
      'msg_opaque',
      'QSTASH_DELIVERY_FAILED',
      'QStash exhausted delivery retries with HTTP 503.',
    );
  });

  it('does not dispatch a parsed payload when its raw-body signature is invalid', async () => {
    const f = fixture();
    f.receiver.verify.mockResolvedValueOnce(false);

    await expect(
      f.controller.execute(f.request(JSON.stringify({ runId })) as never),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.runs.deliver).not.toHaveBeenCalled();
  });

  it('treats a QStash receiver verification error as an invalid signature', async () => {
    const f = fixture();
    f.receiver.verify.mockRejectedValueOnce(new Error('malformed JWT'));

    await expect(
      f.controller.execute(f.request(JSON.stringify({ runId })) as never),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.runs.deliver).not.toHaveBeenCalled();
  });
});
