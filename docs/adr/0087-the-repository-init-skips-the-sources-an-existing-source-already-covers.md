# ADR 0087: The Repository init skips the sources an existing source already covers

Status: accepted
Date: 2026-10-02

## Context

The Repository init (ADR 0075) registers one issues source and one pull
request source per repository it makes factory-ready, checking only that the
operator has not taken the predictable names for another purpose and that the
plane has not already registered the pair. A hand-written broad source that
lists the repository alongside others is invisible to both checks, so a
config that held such a source plus init-registered pairs fetched the same
ticket from two sources every refresh - in the diagnostic session of 2026-10-02
a broad source covering four repositories plus five init pairs put every
ticket in two sources, issuing 27 GraphQL search queries per minute, most of
them redundant, until the operator cut the duplicates by hand.

## Decision

Before registering, the init checks each of its two planned sources against
the configured sources: an existing source covers a planned source when the
host is equal, the kind is equal, and the existing source's repository set
contains the planned source's repository - each planned source names exactly
one. A covered source is not registered. The outcome names every skipped
source with its covering source, so the operator reads the decision in the
init answer.

The check is additive: the same-name collision refusal and the plane-source
re-init comparison stand unchanged, and the check lives beside the
plane-source comparison in the generator module. The coverage test subsumes
the plane-source comparison for the registration split - a plane-registered
source covers itself, so the re-init's skip stands on the one rule. The skip
is derived from the current config on every run: it stands on a re-run while
the covering source stands, and the pair registers when the covering source
leaves the config. The init fact still stands after a skipped registration,
so the drift the plane reports is not about sources.

No config validation changes: a config that already holds overlapping sources
stays valid, and the plane does not repair or advise on the operator's own
edits. Merging the repository into the operator's broad source was
considered and declined: a write into the operator's source is a larger
intervention than a skip, and the skip leaves the operator's file untouched.

## Consequences

- The init's default path is unchanged for a repository no source lists, and
  a repository an operator source only partly covers gains the missing feed
  alone.
- The operator's covering source keeps its own name, filter, and refresh
  interval: coverage holds on host, kind, and repository alone, so the
  machine's label states, which derive position from labels, stay intact
  under the operator's own filter.
- A same-name collision still refuses before any external change, even where
  the coverage check would skip, so the skip path does not weaken the
  collision refusal.
- A source on another host that names the same owner and name is no coverage:
  coverage is per host.
