# Vercel and QStash schedule-run recovery

Each new schedule run is written with a durable dispatch-outbox row before it
is published. The reconciliation endpoints recover a publish interrupted by a
network/database failure and settle a recorded QStash terminal failure after a
crashed worker lease expires.

## Primary trigger: QStash schedule

Create a separate recurring QStash schedule for each environment using its
stable API origin and environment-specific credentials. Configure every field
explicitly in the QStash console or trusted operator SDK:

| Setting | Required value |
| --- | --- |
| Destination method | `POST` |
| Destination URL | `https://<public-api-host>/api/internal/schedule-runs/reconcile` |
| Destination header | `Content-Type: application/json` |
| Body | Exactly `{}` — an empty JSON object, not an empty body or quoted string |
| Cron | `*/5 * * * *` — every five minutes, UTC |

Use the host (and explicit port, if any) from the stable HTTPS `API_PUBLIC_URL`
for `<public-api-host>`; the destination is that origin plus the recovery path.
The path above uses the default `API_GLOBAL_PREFIX=api`; if the accepted release
uses another prefix, substitute that exact prefix. The URL must match the
configured `scheduleDispatch.reconcileUrl`, including scheme, host and path;
do not append a slash or query string. Confirm the selected QStash plan permits
the five-minute cadence before enabling it; if it cannot, record the unresolved
cadence decision rather than silently changing the recovery interval.

When using the QStash schedule REST API, specify `Upstash-Method: POST`,
`Upstash-Cron: */5 * * * *`, and `Content-Type: application/json` on schedule
creation. Check the saved destination headers as well: the API request arriving
at UltraKIL must have `Content-Type: application/json`. QStash also supports
explicit forwarding with `Upstash-Forward-Content-Type: application/json`.
These method/content-type/header controls follow the
[QStash create-schedule API](https://upstash.com/docs/qstash/api-reference/schedules/create-a-schedule).

The endpoint verifies QStash's signature over the exact `rawBody`. UltraKIL's
Nest JSON parser supplies that raw body; missing or incorrect JSON content type
can leave it unavailable and produce **401** even when QStash supplied a
signature. Do not change the payload to make a failing signature pass, add a
browser bearer token, or put any run/customer data in this request.

Before claiming recovery readiness, observe a real delivery from each recurring
schedule and record signed smoke evidence: environment, exact deployed SHA,
destination URL/method, JSON header and `{}` body confirmation, cron expression,
UTC delivery time, and **204 No Content** response after signature verification.
Retain schedule/message IDs in private operator evidence. Never copy tokens,
signatures or signing keys into the shared checklist. A local unit test, an
unsigned browser request, or the existence of a schedule alone does not satisfy
this gate. If delivery fails, keep the gate open and verify destination headers,
URL, environment signing keys and Deployment Protection privately.

## Daily Vercel Cron safety net

This fallback runs only on Vercel Production, never on the staging Preview
branch; staging depends on the signed recurring QStash schedule above.
The API project's [`vercel.json`](../apps/api/vercel.json) adds a daily UTC
sweep at 03:00. Set a random `CRON_SECRET` of at least 32 characters in Vercel;
Vercel sends it as
`Authorization: Bearer <CRON_SECRET>` to:

```
GET https://<public-api-host>/api/internal/schedule-runs/reconcile
```

On Vercel Hobby, cron jobs run no more than once per day and can be invoked at
any time during the selected hour. It is therefore deliberately a fallback,
not a substitute for the QStash schedule. Higher-frequency or precise Vercel
Cron recovery requires a paid plan.

Sources: [Vercel Cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Vercel Cron authentication](https://vercel.com/docs/cron-jobs/manage-cron-jobs), and [QStash schedules](https://upstash.com/docs/qstash/features/schedules).
