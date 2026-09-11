import { HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/errors/app.exception';
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

  it('returns a generic error and preserves the upstream status when the scheduler rejects a request', async () => {
    const rawBody =
      'scheduler.internal:8000 leaked response; SCHEDULER_API_TOKEN=secret-token; PrismaClientKnownRequestError';
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: HttpStatus.BAD_GATEWAY,
      text: async () => rawBody,
    });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const error = await new SchedulerClient(config)
      .solve({} as SolveRequest, 1000)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect((error as AppException).code).toBe('SCHEDULER_UNAVAILABLE');
    expect((error as AppException).message).toBe(
      'The scheduling service rejected the request. Please try again.',
    );
    expect(JSON.stringify((error as AppException).getResponse())).not.toContain(rawBody);
    expect(JSON.stringify((error as AppException).getResponse())).not.toContain(
      'scheduler.internal',
    );
    expect(JSON.stringify((error as AppException).getResponse())).not.toContain(
      'secret-token',
    );
    expect((error as AppException).getResponse()).toMatchObject({
      details: { status: HttpStatus.BAD_GATEWAY },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /"event":"scheduler\.solve\.failed".*"kind":"http".*"status":502.*"responseBodyLength":\d+/,
      ),
    );
    expect(warn.mock.calls.flat().join(' ')).not.toContain(rawBody);

    warn.mockRestore();
  });

  it('returns a generic unavailable error when transport diagnostics contain internal details', async () => {
    const rawReason =
      'fetch failed for https://scheduler.internal:8000/solve; token=secret-token; check SCHEDULER_BASE_URL';
    fetchMock.mockRejectedValueOnce(new Error(rawReason));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const error = await new SchedulerClient(config)
      .solve({} as SolveRequest, 1000)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect((error as AppException).code).toBe('SCHEDULER_UNAVAILABLE');
    expect((error as AppException).message).toBe(
      'The scheduling service is temporarily unavailable. Please try again.',
    );
    expect(JSON.stringify((error as AppException).getResponse())).not.toContain(
      'scheduler.internal',
    );
    expect(JSON.stringify((error as AppException).getResponse())).not.toContain(
      'secret-token',
    );
    expect(JSON.stringify((error as AppException).getResponse())).not.toContain(
      'SCHEDULER_BASE_URL',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /"event":"scheduler\.solve\.failed".*"kind":"transport"/,
      ),
    );
    expect(warn.mock.calls.flat().join(' ')).not.toContain('scheduler.internal');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret-token');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('SCHEDULER_BASE_URL');

    warn.mockRestore();
  });
});
