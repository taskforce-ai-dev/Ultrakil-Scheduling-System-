const DEFAULT_ADMIN_PASSWORD = 'ultrakil-change-me';

/** Seeds run outside the API bootstrap, so they need their own production guard. */
export function assertProductionSeedCredentials(env: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
  if (env.NODE_ENV !== 'production') return;
  const email = env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email || email.startsWith('replace-with') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('SEED_ADMIN_EMAIL must be explicitly configured for production seeds');
  }
  const password = env.SEED_ADMIN_PASSWORD?.trim();
  if (!password || password.length < 24 || password !== env.SEED_ADMIN_PASSWORD
    || password === DEFAULT_ADMIN_PASSWORD || /replace-with|change-me|changeme|placeholder/i.test(password)) {
    throw new Error('SEED_ADMIN_PASSWORD must be explicitly configured for production seeds');
  }
}

export function assertDemoSeedAllowed(env: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
  if (env.NODE_ENV === 'production') throw new Error('DEMO_SEED_FORBIDDEN_IN_PRODUCTION');
}
