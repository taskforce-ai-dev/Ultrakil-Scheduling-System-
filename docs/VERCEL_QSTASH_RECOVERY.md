# Vercel and QStash schedule-run recovery

Each new schedule run is written with a durable dispatch-outbox row before it
is published. The reconciliation endpoints recover a publish interrupted by a
network/database failure and settle a recorded QStash terminal failure after a
crashed worker lease expires.

## Primary trigger: QStash schedule

Create a recurring QStash schedule that sends a signed JSON body of exactly
`{}` to:

```
POST https://<public-api-origin>/api/internal/schedule-runs/reconcile
```

The endpoint verifies the normal QStash signature; do not add a browser bearer
token or any run/customer data to its body. Use a cadence appropriate to the
QStash plan (for example every five minutes) so pending publishes and expired
terminal failures recover promptly. QStash schedules support cron expressions
and can be managed in its console or SDK.

## Daily Vercel Cron safety net

The API project's [`vercel.json`](../apps/api/vercel.json) adds a daily UTC
sweep at 03:00. Set a random `CRON_SECRET` of at least 32 characters in Vercel;
Vercel sends it as
`Authorization: Bearer <CRON_SECRET>` to:

```
GET https://<public-api-origin>/api/internal/schedule-runs/reconcile
```

On Vercel Hobby, cron jobs run no more than once per day and can be invoked at
any time during the selected hour. It is therefore deliberately a fallback,
not a substitute for the QStash schedule. Higher-frequency or precise Vercel
Cron recovery requires a paid plan.

Sources: [Vercel Cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Vercel Cron authentication](https://vercel.com/docs/cron-jobs/manage-cron-jobs), and [QStash schedules](https://upstash.com/docs/qstash/features/schedules).
