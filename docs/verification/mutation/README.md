# The last campaign's report

The entry point's convention, so a future reader starts from data instead of
re-running a campaign:

- `last-campaign.json` is the raw report of the last campaign that is not a dry
  run and that reached its reporter: byte-for-byte the `mutation.json` Stryker
  wrote to `reports/mutation/`, copied by `scripts/mutate.sh` when the run
  ends. It holds every mutant the campaign measured, its status, and the tests
  that covered it - the data a triage of survivors reads.
- `last-campaign.meta.json` names what that report belongs to: the head SHA it
  was measured on, the day, the scope the caller covered, and the worker
  count. A report without its head is a number without its tree; when the head
  has moved on, the report is stale data to re-run, not truth.

Only a finished campaign's report lands here. A dry run measures the budget
and never touches these files, and a run that dies in its initial run, or on
a native crash, never reaches the reporter, so the last campaign's data
stands until a campaign rewrites it. The human-readable `mutation.html` stays
in `reports/mutation/`, working space, and is not committed.

The campaign that writes these files commits them with its report of what it
measured, the way the verification record carries the measured facts in
prose beside the raw data here.
