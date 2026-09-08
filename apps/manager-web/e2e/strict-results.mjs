export function assertStrictResults(tests) {
  if (tests.length < 48 || tests.some(test => test.expectedStatus !== 'passed'
    || test.results.length === 0 || test.results.at(-1).status !== 'passed')) {
    throw new Error('Strict acceptance requires every journey to execute and pass; missing/skipped/expected-failure tests block release.');
  }
}
