# ULK-O14 rolling coverage — deployed UAT matrix

Status: NOT YET RUN on a deployed O13/O14+C13 build. This matrix is a test plan,
not a sign-off. Keep O12's deployed pagination/Calendar UAT evidence separate.

| Scenario | Expected manager-visible result | Evidence required |
| --- | --- | --- |
| All 30 days verified, all due visits published | Green banner names the exact window end as covered-through; drafts do not contribute | API counts, desktop and 375px/768px browser screenshots |
| Verified no-due boundary day | Green only with a completed current sweep for each branch; zero visits alone is not green | API record and browser screenshot |
| Newly exposed day has complete drafts but unconfirmed provenance | Amber “Prepared, awaiting manager review”; 0 published for that day; Assign Crew link | Warning list, genuine manager acknowledgement/reason path, no auto-publish |
| One due visit cannot be staffed | Amber shortfall on first affected day, stable reason, Unassigned Visits link; none of that day's new proposals auto-published | Count-only API evidence and browser screenshot |
| Sweep missing, stale, in progress or failed | No all-clear, distinct state and review action | API status and browser screenshot |
| New agreement after successful sweep | Affected day loses verified status until re-evaluated; existing published work stays protected | Before/after API status and run evidence |
| Manual override after successful sweep | Audit reason and hard rules preserved; coverage revalidated before next all-clear | API/audit count-only evidence |
| Rapid date/branch switch with slow responses | Late old response never replaces the new range's banner | Deterministic UI test and browser network trace |
| 30-day rollover at Colombo midnight | New boundary already prepared; no midnight-to-cron coverage gap | Clock-boundary test and deployed count-only check |
| API failure/offline | Calendar stays usable, but banner says coverage status unavailable, never green | Browser network/console evidence |

Acceptance gate: exact-head CI, PostgreSQL-backed integration and concurrency
tests, read-only count audit, isolated backup/restore/rollback rehearsal, and
desktop/375px/768px real-browser UAT on the exact staged image. Record the
release SHA, screenshots outside public Git if they contain real names, and
any deviations. Do not mark O14 complete from local fixtures alone.
