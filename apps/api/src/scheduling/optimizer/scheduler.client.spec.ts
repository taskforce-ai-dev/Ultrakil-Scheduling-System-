import { ConfigService } from '@nestjs/config';
import { SchedulerClient, SolveRequest, SolveResponse } from './scheduler.client';

const answer = {
  run_id: 'run-1',
  status: 'OPTIMAL',
  assignments: [],
  unassigned: [],
  solve_seconds: 0,
  objective_value: 0,
  visits_considered: 0,
} as SolveResponse;

describe('SchedulerClient', () => {
  let token: string | undefined;
  let fetchMock: jest.Mock;

  const config = {
    getOrThrow: (key: string) => {
      if (key === 'scheduler.baseUrl') return 'https://scheduler.vercel.app';
      throw new Error(`Unexpected config key: ${key}`);
    },
    get: (key: string) => (key === 'scheduler.apiToken' ? token : undefined),
  } as unknown as ConfigService;

  beforeEach(() => {
    token = undefined;
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => answer,
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('sends the configured bearer token to the solve endpoint', async () => {
    token = 's'.repeat(32);

    await new SchedulerClient(config).solve({} as SolveRequest, 1000);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://scheduler.vercel.app/solve',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      }),
    );
  });

  it('omits authorization for local development without a token', async () => {
    await new SchedulerClient(config).solve({} as SolveRequest, 1000);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://scheduler.vercel.app/solve',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
  });
});
