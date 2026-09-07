/** Fail before test modules can connect or register destructive fixtures. */
export function assertTestDatabaseUrl(value: string | undefined): void {
  let isTestDatabase = false;
  try {
    const url = new URL(value ?? '');
    const database = decodeURIComponent(url.pathname.slice(1));
    isTestDatabase =
      ['postgresql:', 'postgres:'].includes(url.protocol) &&
      url.hostname.length > 0 &&
      /^[a-zA-Z0-9_]+_test$/.test(database);
  } catch {
    // Never include the URL, hostname or credentials in the refusal.
  }
  if (!isTestDatabase) {
    throw new Error(
      'Unsafe integration test database: use a dedicated PostgreSQL database ending in _test.',
    );
  }
}
