describe('integration database safety gate', () => {
  const originalUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  const loadIntegrationSetup = () => jest.isolateModulesAsync(async () => {
    jest.requireActual('../integration/jest.setup');
  });

  it.each([
    undefined, '', 'not-a-url',
    'postgresql://user:secret@localhost:5432/ultrakil',
    'postgresql://user:secret@localhost:5432/ultrakil_dev',
    'postgresql://user:secret@localhost:5432/ultrakil_production',
    'postgresql://user:secret@localhost:5432/test_ultrakil',
    'postgresql://user:secret@localhost:5432/ultrakil_test_prod',
    'postgresql://user:secret@localhost:5432/',
    'postgresql://user:secret@localhost:5432/ultrakil_test/other',
    'postgresql://user:secret@localhost:5432/ultrakil_test%2Fother',
    'https://user:secret@localhost/ultrakil_test',
  ])('refuses an unsafe or absent database URL before suite code executes (case %#)', async (url) => {
    if (url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = url;
    await expect(loadIntegrationSetup()).rejects.toThrow('dedicated PostgreSQL database ending in _test');
  });

  it.each([
    'postgresql://dev@127.0.0.1:55432/ultrakil_test?schema=public',
    'postgresql://ultrakil:ci-secret@localhost:5432/ultrakil_test?schema=public',
    'postgres://dev@localhost:5432/isolated_run_123_test',
  ])('accepts an explicitly named test database (case %#)', async (url) => {
    process.env.DATABASE_URL = url;
    await expect(loadIntegrationSetup()).resolves.toBeUndefined();
  });

  it('does not expose the URL or credentials in the refusal', async () => {
    process.env.DATABASE_URL = 'postgresql://private-user:private-secret@private-host/production';
    const failure = await loadIntegrationSetup().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toMatch(/private-user|private-secret|private-host/);
  });
});
