# UltraKIL — staging business-acceptance script

**Application release under acceptance:**
`500daf80a85aea18ca5e5d74d2552739b7e3fb57` (PR #75)

**Ingress configuration:**
`a8174accb7d99248ba415fe78bb227c49aac23e9` (PR #76)

**Current evidence and guidance:**
`main@b9e7536c74d96b2ef87766bac558af88e1badc0f`

**Portal:** `https://ultrakil.taskforceai.tech`

**Expected duration:** 30–40 minutes

This checklist is for a named UltraKIL representative to decide whether the
current staging system matches the business workflow. It is separate from the
technical UAT record: automated and technical checks establish that the
software follows its rules, while business acceptance establishes that those
rules and workflows are useful to UltraKIL.

## Current release gate

This script may be run against staging now. It must not be used to sign a
production release until the authentication-hardening item in
`known-limitations.md` is closed and the resulting release is deployed and
retested. The current browser session is stored in `localStorage`, and failed
logins are not yet throttled. Those are production security gates, not hidden
conditions of this acceptance exercise.

The current technical evidence is recorded in
`uat/ULK-O08-uat-results.md`. In summary:

- 74 current/future published assignments have no employee or vehicle
  overlap, sub-60-minute different-site travel conflict, short or overstaffed
  crew, missing PMS supervisor, missing required skill, unauthorized driver,
  invalid transport, duplicate active visit assignment or multi-vehicle
  assignment.
- A restored, isolated clone scheduled all 1,506 pending visits in the rolling
  12-month horizon without adding more synthetic resources.
- A deployed read-only browser pass ran 42 checks: 41 passed and one was
  skipped because the imported dataset has no wholly inactive customer.
- All six staging services are healthy, the approved 11-assignment repair is
  recorded exactly once, and the portal and API return HTTP 200.

These facts support the exercise; they do not sign it on the client's behalf.

## Before starting

| Item | Requirement |
| --- | --- |
| Decision maker | A named UltraKIL representative authorized to accept the workflow |
| Facilitator | A delivery-team member who can record findings and restore the controlled test assignment |
| Browser | Current desktop or laptop Chrome, Edge or Firefox |
| Account | An active manager or administrator account supplied securely; the controlled write test in Section 6 requires an administrator |
| Write-test visit | One future, unlocked visit with one editable DRAFT or PROPOSED assignment (not published history), an eligible alternative date and an eligible alternative crew, vehicle or time; record its current business state first |

If any screen differs from the expected result, mark that section **FAIL** and
record the exact page, date/branch filter, visit identifier, action and visible
message. Report the finding to the Technical Director before changing other
data or trying to explain it away.

## 1. Sign-in and navigation

1. Open the portal and sign in.
2. Confirm that **Dashboard** loads.
3. Use the navigation to open **Calendar**, **Dispatch Board**, **Unassigned
   Visits**, **Customers**, **Service Agreements**, **Workforce** and
   **Vehicles**.
4. Sign out, then sign in again.

Expected result:

- Each page loads without a blank screen or browser error.
- Signing out removes access to manager pages.
- An incorrect password produces a generic credential error without revealing
  whether the email exists.

| Result | ☐ PASS ☐ FAIL ☐ NOT RUN |
| --- | --- |
| Initials and notes | |

## 2. Calendar and dispatch visibility

1. Open **Calendar** and move between at least three months.
2. Open a day containing visits and follow its link to the relevant work.
3. Open **Dispatch Board**, select a date with scheduled work and review each
   visible crew and vehicle.
4. Switch dates while the page is loading and confirm the final screen matches
   the date currently selected.
5. Open **Unassigned Visits** and confirm unresolved work is presented as work
   needing attention rather than silently hidden.
6. In the Dispatch Board's list view, use **Share** and confirm the shared text
   names the date and branch currently displayed. Switch to Calendar view and
   confirm the list-only Share action is no longer offered.

Expected result:

- Customer, site, date, time, crew, vehicle and assignment state are readable.
- A visit never displays several vehicles; the supported maximum is one.
- A person or vehicle is not shown on overlapping visits.
- Changing the date cannot leave totals, rows or Share output from the previous
  date on screen.

| Result | ☐ PASS ☐ FAIL ☐ NOT RUN |
| --- | --- |
| Initials and notes | |

## 3. Customers, sites and agreements

1. Open **Customers** and locate a familiar customer.
2. Review its sites and confirm an inactive site remains visible as historical
   information and is explicitly labelled **Inactive**.
3. Open **Service Agreements** and inspect frequency, allowed/preferred days,
   crew size, duration, skills, service window and provenance.
4. Start the Add Agreement form. Confirm an inactive site is not offered for
   new work, then move the duration slider and confirm the readable duration
   and numeric value stay synchronized. Close without saving.

Expected result:

- Historical inactive records are preserved but do not generate or accept new
  work.
- Job duration is adjustable in 15-minute steps and can represent different
  site sizes rather than assuming every job takes the same time.
- Imported 08:00–17:00 hours are visibly marked as assumed/unconfirmed where
  real hours are unavailable.
- Inferred site/branch data is presented as needing confirmation, not as a
  verified fact.

| Result | ☐ PASS ☐ FAIL ☐ NOT RUN |
| --- | --- |
| Initials and notes | |

## 4. Workforce and vehicle authorization

1. Open **Workforce** and inspect an employee's branch, grade, PMS status,
   skills, deployment type, public-transport capability and vehicle
   authorizations.
2. Open **Vehicles** and inspect each of these known multi-driver vehicles:
   `DAG-3284`, `ABE-7244`, `PJ-6796`, `DAI-0191` and `DAC-2485`.
3. Confirm each checked driver is presented equally. There must be no primary,
   owner or preferred-driver priority.

Expected result:

- A Technician Matrix checkmark means that employee may drive that vehicle.
- An unchecked employee is never presented as an authorized driver.
- Personal, company-owned and company-rented vehicles use the same rule.
- `DAC-2485` is normalized correctly and has three authorized drivers.

| Result | ☐ PASS ☐ FAIL ☐ NOT RUN |
| --- | --- |
| Initials and notes | |

## 5. Constraint explanations without saving

1. Open a future visit in **Dispatch Board** or **Unassigned Visits** and choose
   **Edit crew**.
2. Deliberately construct an invalid proposal, one condition at a time:
   insufficient crew, no PMS supervisor, a missing required skill, a vehicle
   without an authorized driver, or no vehicle for someone who cannot use
   public transport.
3. Observe the Validation panel after each change.
4. Add a second vehicle and confirm the proposal is rejected.
5. Close the editor without saving.

Expected result:

- Every applicable conflict is shown in plain language with corrective
  guidance.
- The system refuses invalid proposals; it does not silently bypass branch,
  PMS, skill, driver, transport, absence, overlap or travel rules.
- A vehicle is available only when at least one checked driver is included in
  the crew and named as the driver.

| Result | ☐ PASS ☐ FAIL ☐ NOT RUN |
| --- | --- |
| Initials and notes | |

## 6. Controlled manual override and recovery

This is the only section that changes staging data and it requires an
administrator account. Use only the approved future visit. Before starting,
confirm that it is unlocked, currently assigned as an editable DRAFT or
PROPOSED assignment, and is not published history. Record its visit identifier,
date, original crew, vehicle, driver, timing, pin state and assignment reason.
The visit must have one eligible alternative date and one eligible alternative
crew, vehicle or time agreed by the facilitator before the session.

1. In **Calendar**, use the visit's move action to select the approved
   alternative date. Enter a meaningful move reason and choose **Move visit**.
2. Reload the calendar and confirm that the visit appears only on the new date.
3. Move the visit back to its original date with a separate restoration reason,
   then reload and confirm that it appears only on the original date.
4. Open **Edit crew** for the restored visit.
5. Change at least one of crew, vehicle, driver or timing while keeping the
   required number of people, PMS coverage, required skills and either
   compliant public transport or one vehicle with an authorized crew driver.
6. Confirm the Validation panel says the changed crew is eligible.
7. Enter a meaningful **Reason for this change** and save.
8. Reopen the same visit and confirm it does not report a conflict against its
   own saved assignment.
9. Use the pin controls to protect one deliberate decision, supply a pin reason,
   then reopen the visit and confirm the pin persists. Release that pin again.
10. Restore the exact original crew, vehicle, driver, timing and pin state with
    a separate restoration reason. Reopen the visit and compare its business
    state with the values recorded before Step 1. Keep the new audit history:
    the test and its restoration must remain explainable rather than erased.

Expected result:

- An administrator can move a visit to an eligible date and restore its
  original date without duplicating or losing it.
- An administrator can override a crew, vehicle or timing decision within the
  permitted service window.
- Every manual change requires and retains an audit reason.
- Reopening a saved assignment does not create false self-overlap errors.
- Pinned decisions are explicit and survive reopening.
- The controlled visit is returned to its original business state at the end;
  its added audit entries remain intentionally.

| Result | ☐ PASS ☐ FAIL ☐ NOT RUN |
| --- | --- |
| Visit identifier and restoration evidence | |
| Initials and notes | |

## 7. Repair Center and operational honesty

1. Open **Repair Center**.
2. Confirm the page distinguishes immutable historical findings from current or
   future findings that could be repaired.
3. Do not apply another repair during acceptance.
4. Review `known-limitations.md` with the facilitator.

Expected result:

- Historical findings remain visible for audit and are not presented as
  current dispatch work.
- The approved repair is not offered for duplicate application.
- Current limitations are visible and understandable before a decision is
  signed.

| Result | ☐ PASS ☐ FAIL ☐ NOT RUN |
| --- | --- |
| Initials and notes | |

## Limitations requiring an informed decision

Read these before signing:

- **Authentication hardening:** the staging workflow may be tested, but
  production approval remains blocked until browser tokens move out of
  `localStorage` and failed-login throttling is implemented and verified.
- **Site mapping:** 408 sites have uncertain branch provenance, including 394
  active sites affecting 826 future visits. This is source-data confirmation
  work; the software must not invent the missing mappings.
- **Opening hours:** imported 08:00–17:00 hours are an explicit unconfirmed
  fallback until UltraKIL supplies real hours.
- **Kandy:** this dataset contains no Kandy work and no PMS-qualified Kandy
  supervisor. The no-bypass rule is implemented and tested but cannot be
  demonstrated on a live Kandy row in this dataset.
- **Inactive customer scenario:** no wholly inactive customer exists in the
  current import. Inactive-site exclusion is demonstrable; the wholly inactive
  customer case is covered by automated tests rather than live data.
- **Synthetic capacity:** staging contains two clearly labelled synthetic
  employees and one synthetic vehicle. The full-year audit proves no additional
  synthetic capacity is currently needed. More may be added only when an
  authoritative feasibility audit proves a real shortfall.
- **Portal scope:** technicians and supervisors do not yet have a mobile field
  application or push notifications.
- **Transport model:** one vehicle may serve a visit. Splitting one crew across
  several vehicles is outside this release.

## Acceptance decision

I ran or deliberately marked every section above, reviewed all failures and
not-run items, confirmed that the controlled assignment was restored, and read
the limitations.

| Field | Entry |
| --- | --- |
| Sections passed | ______ of 7 |
| Sections failed | ______ |
| Sections not run | ______ |
| Finding references | |

Choose one:

- ☐ **Accepted for continued staging/pilot testing.**
- ☐ **Accepted with conditions.** List the conditions below.
- ☐ **Not accepted.** List the reasons below.
- ☐ **Production acceptance deferred** until authentication hardening and the
  listed conditions are closed.

Conditions or reasons:

```text


```

| Field | Entry |
| --- | --- |
| Name | |
| Role | |
| Organisation | |
| Signature | |
| Date | |
| Delivery-side witness | |
| Witness date | |

A signature records the named business decision above. Passing CI, UAT or
technical audits cannot substitute for that decision.
