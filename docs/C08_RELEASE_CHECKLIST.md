# C08 release evidence and O08 handoff

> Current deployment target: Vercel Preview/Production. There is no dedicated
> staging server; the historical Docker-host procedure is retained in
> [`STAGING_RUNBOOK.md`](STAGING_RUNBOOK.md) for the preserved Compose path.
> Use [`VERCEL_DEPLOYMENT.md`](VERCEL_DEPLOYMENT.md) for current deployment
> evidence.

Record links/results against the exact release SHA; unchecked items remain open.
This C08 checklist complements Oshadi's separate O08 guide, screenshots and demo
script. It does not transfer O08 ownership or include branding PR #36.

- [ ] C07 accepted; C08 reviewed on that state; full latest-head CI green.
- [ ] Synthetic Docker lifecycle CI green with all 48 required journeys run,
  no skipped tests, clean/idempotent migrations and both imports repeated.
- [ ] Exact source SHA, accepted Compose file/retained release checkout and
  API/web/scheduler/tooling/recovery image IDs recorded.
- [ ] Authorized UltraKIL host/IP, SSH user/key, sudo scope, host resources,
  DNS names, TLS certificate ownership and firewall/pilot CIDRs confirmed.
- [ ] Private environment, imports/reports/backups and UID permissions checked.
- [ ] HTTPS portal/API URLs verified from the pilot network, with readiness,
  login/CORS, every service healthy and ten minutes of clean runtime evidence.
- [ ] Loopback API/web probes pass locally; same-L2 peer exposure checks prove
  direct 3000/3001 access is blocked (required firewall evidence on Engine <28).
- [ ] Real workbooks privately imported twice through the strict wrapper;
  numeric summaries attached, private reports retained only for approved review.
- [ ] All five multi-driver vehicles, every checked-driver choice, unchecked
  rejection and unavailable-driver cases verified against the actual matrix.
- [ ] DAC-2485 normalized and prior DAG-3284 real-data scenario rerun.
- [ ] Red identity records remain inactive after re-import; red dates/headers
  stay active as appropriate, no future inactive jobs, historical jobs retained.
- [ ] Kandy remains unassigned without a qualified branch PMS supervisor.
- [ ] Assumed 08:00–17:00 hours stay visibly unconfirmed. Real hours unavailable
  is recorded as an operational limitation, not marked resolved.
- [ ] The previously reported 408 uncertain site mappings have explicit closure
  evidence per site or remain an open operational decision list.
- [ ] Immediate/daily backup health, exact SHA-256 archive, isolated restore
  count parity and exact disposable cleanup evidence recorded.
- [ ] Remote destination, pinned SSH key, upload identity, age recipient and
  separate recovery-key custodian authorized; independent off-host restore
  completed. Local/offline tooling proof alone leaves this item unchecked.
- [ ] Prior release Compose/image compatibility reviewed, maintenance ingress
  verified, queues drained/paused, prebackup verified, all application services
  restarted from the recorded Compose definition and artifacts, and no
  publication/outbox replay observed. First release records that no prior
  Compose/image pair exists rather than claiming rollback proof.
- [ ] Staging build/URL securely handed to Oshadi only after verification.
- [ ] Oshadi attaches her final real-staging UAT including scenarios 4–7, O09
  regression evidence, screenshots matching the deployed SHA, manager guide,
  demo script and zero unresolved critical/high defects (including assignment
  reopening/self-overlap retest).
- [ ] ClickUp C08 and O08 have truthful evidence, known limitations and ownership
  handover; complete only after each task's actual Definition of Done is met.

If a gate is blocked, record the exact missing host/credential/data decision or
failed test. Do not publish invented staging URLs, claim synthetic screenshots
as staging evidence or assign work to Chanya during her absence.
