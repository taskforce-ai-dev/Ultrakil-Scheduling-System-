export function validateStrictEnvironment(env) {
  const id = env.E2E_REHEARSAL_ID;
  if (!/^[a-f0-9]{12}$/.test(id ?? '') || env.E2E_DATABASE_NAME !== `ultrakil_rehearsal_${id}_test`
    || env.E2E_BULLMQ_PREFIX !== `ultrakil-rehearsal-${id}` || env.E2E_DATE !== '2026-09-07') {
    throw new Error('Strict E2E requires its isolated synthetic rehearsal database, queue prefix and date.');
  }
  for (const key of ['E2E_BASE_URL', 'E2E_API_URL']) {
    const url = new URL(env[key]);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || !url.port || url.username || url.password) {
      throw new Error('Strict E2E only accepts the isolated loopback Compose endpoints.');
    }
  }
}
