import { ConfigService } from '@nestjs/config';

import {
  qstashMaximumRangeDays,
  QStashScheduleRunDispatcher,
} from './schedule-run.dispatcher';

function fixture() {
  const client = {
    publishJSON: jest.fn(async () => ({ messageId: 'msg_opaque' })),
    messages: { cancel: jest.fn(async () => undefined) },
  };
  const values: Record<string, string | number> = {
    'scheduleDispatch.qstash.token': 'test-token',
    'scheduleDispatch.executeUrl':
      'https://ultrakil.example.com/api/internal/schedule-runs/execute',
    'scheduleDispatch.failureUrl':
      'https://ultrakil.example.com/api/internal/schedule-runs/failure',
    'scheduleDispatch.executionBudgetSeconds': 55,
  };
  const config = {
    getOrThrow: jest.fn((key: string) => values[key]),
  };
  return {
    client,
    dispatcher: new QStashScheduleRunDispatcher(
      config as unknown as ConfigService,
      client,
    ),
  };
}

describe('QStashScheduleRunDispatcher', () => {
  it('publishes only an opaque run ID with the signed execute and failure destinations', async () => {
    const { client, dispatcher } = fixture();

    await expect(
      dispatcher.enqueue({
        runId: 'e53c9feb-f68f-4c6f-8ba5-31939e3a5000',
        dispatchId: 'ab839d87-6e0d-4b08-a6d1-f3e352a6f4a4',
      }),
    ).resolves.toBe('msg_opaque');

    expect(client.publishJSON).toHaveBeenCalledWith({
      url: 'https://ultrakil.example.com/api/internal/schedule-runs/execute',
      body: {
        runId: 'e53c9feb-f68f-4c6f-8ba5-31939e3a5000',
        dispatchId: 'ab839d87-6e0d-4b08-a6d1-f3e352a6f4a4',
      },
      failureCallback:
        'https://ultrakil.example.com/api/internal/schedule-runs/failure',
      retries: 3,
      timeout: '55s',
      deduplicationId: 'ab839d87-6e0d-4b08-a6d1-f3e352a6f4a4',
    });
  });

  it('keeps at least five seconds below Vercel Hobby for the response while supporting a week', () => {
    const { dispatcher } = fixture();

    expect(dispatcher.maxRangeDays).toBe(9);
    expect(qstashMaximumRangeDays(47)).toBe(1);
  });

  it('treats remote cancellation as best effort', async () => {
    const { client, dispatcher } = fixture();
    client.messages.cancel.mockRejectedValueOnce(new Error('transient'));

    await expect(dispatcher.cancel('msg_opaque')).resolves.toBeUndefined();
    await expect(dispatcher.cancel(null)).resolves.toBeUndefined();
    expect(client.messages.cancel).toHaveBeenCalledTimes(1);
  });
});
