# Vercel C08 release evidence

This is the current C08 checklist for the three Vercel Projects. It replaces
the historical Docker-host checklist for deployment evidence; no SSH host,
firewall, Compose, image, or backup-host evidence is required for this Vercel
path.

- [ ] Three Vercel Projects are connected to the repository with root
  directories `apps/manager-web`, `apps/api`, and `services/scheduler`.
- [ ] “Include source files outside of the Root Directory” is enabled for each
  project, and the expected framework/runtime is detected.
- [ ] Preview deployments and Production deployments each complete without
  build errors; record the exact deployed commit SHA and URLs.
- [ ] `apps/api` runs `pnpm prisma:generate && pnpm build`; scheduler runtime
  dependencies are installed from `pyproject.toml`.
- [ ] `NEXT_PUBLIC_API_BASE_URL` points to the stable Production API domain
  with `/api`; `API_CORS_ORIGINS` is the stable Production manager domain.
- [ ] `SCHEDULER_BASE_URL` is the stable Production scheduler domain over HTTPS.
- [ ] The same randomly generated `SCHEDULER_API_TOKEN` is present in the API
  and scheduler Production variables; it is absent from Git and chat.
- [ ] `SCHEDULER_ALLOW_UNAUTHENTICATED` is not set in either Vercel project.
- [ ] API Production variables include Neon `DATABASE_URL`, reachable managed
  Redis settings, a non-default `JWT_SECRET`, and a non-default seed password.
- [ ] `GET /api/health/live` and `GET /api/health/ready` return the expected
  status through the Production API URL.
- [ ] Manager login, CORS, and an authenticated scheduler solve request pass
  against the stable Production domains.
- [ ] Preview URLs are not described as automatically cross-wired. If a
  Preview is tested separately, record its individual URL and environment
  variables without replacing the stable Production UAT wiring.
- [ ] The preserved Docker/Compose path remains available for local development
  and any separately hosted durable queue worker; QStash and queue/lease
  changes are outside this checklist.
