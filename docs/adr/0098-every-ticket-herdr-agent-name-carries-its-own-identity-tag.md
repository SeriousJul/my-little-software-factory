# Every Ticket's herdr Agent name carries its own identity tag

Status: accepted
Date: 2026-10-04

## Context

`agentNameFor` derived a Ticket's stable herdr Agent name from its title alone:
the title slug, cut to herdr's 32-character agent name rule. The Work cycle
name and the handoff ordinal name added a suffix to the same slug, so every
name one Ticket asks for names the same title.

herdr holds one agent name space across every repository the plane watches. A
title is not unique across it. The plane reads a Pull request as its own
Ticket, and a pull request carries its issue's title; the fixing-pull-request
feature (ADR 0042) makes that pairing routine. A security advisory and its
Dependabot alert carry one title too, because the alert names the advisory.

Issue #216 records what that costs. In the development install three title
pairs collided: `#209`/`#215`, `#45`/`#51`, and `#6`/`#7`. The Dependabot
Ticket `#51` held `ghsa-6h2x-m376-mqjq-joi-quadrati`; the pull request `#45`
asked herdr for that same name on every Handoff and was refused. The refusal
is a stranger collision, so the Handoff fails with no candidate left to try:

```
the herdr name ghsa-6h2x-m376-mqjq-joi-quadrati is held by pane w13K:p1 in
workspace w13K which is no agent of this ticket: agent_name_taken
```

The plane read this as a leftover of its own making. It was not: two Tickets
had asked for one name.

## Decision

**A Ticket's herdr Agent name carries the Ticket's own identity beside its
title slug.** `agentNameFor` builds `<slug>-<tag>`, where the tag is an FNV-1a
32-bit digest of the Ticket's identity, written as eight hexadecimal
characters. The digest is a pure function of the identity string, so the name
is the same in every run, on every machine, and across a version change. It
guards no secret and needs no cryptographic strength: the tag only has to keep
two Tickets apart.

**A truncation of the identity is not the tag.** Every Ticket of one GitHub
source starts its identity with the same words, so the leading characters of
two identities are equal - `shortStableIdentity`, the Consultation's answer,
returns `githubgi` for all of them. The digest reads the whole identity.

**The tag is the whole digest, at eight characters.** herdr's name rule leaves
32 characters for the whole name, so every tag character is taken from the
title slug: the slug gives up its tail first, and the tag never moves. The
width is that budget spent on the one fact the name cannot do without. Six
characters would throw away half of a 32-bit digest and buy nothing back,
because the tag is not a checksum, it is the separator. For a pair of Tickets
whose titles already share their first 23 slug characters, the odds their
digests collide too are one in 4.3 billion. The development install has
carried 432 Tickets and 102 title pairs of more than one Ticket across its
whole record, so the odds that one of its real title collisions also meets a
tag collision are about one in 40 million.

**The tag is not the Ticket's external key.** `#45` and `#51` are two
characters an operator can read, and the branch name already carries them. They
are not the tag because an external key is unique only inside one source: two
repositories the plane watches can each hold a Dependabot alert numbered `#45`
for one advisory, and those two Tickets carry one key and one title. The digest
reads the identity, which names the source and the repository, so it separates
them.

**The tag survives the 32-character cut.** The slug gives up its tail to the
limit first, so a cut name still says which Ticket it belongs to. The Work
cycle name and the handoff ordinal name keep that guarantee: `<slug>-<tag>-c<n>`
and `<slug>-<tag>-c<n>-<m>`.

**The candidate list no longer dedupes.** `ticketAgentNames` used to drop a
candidate that repeated an earlier one, because the length cut could rebuild
the stable name out of a slug whose tail already spelled `-c<cycle>`. With a
fixed-width tag the three candidates differ by construction: each ends in the
tag, and what follows the tag is nothing, then `-c<n>`, then `-c<n>-<m>`.

**The branch keeps its own rule.** `ticketBranchKey` still combines the title
slug with the ticket id, because a branch lives inside one repository while
herdr's name space spans every repository the plane watches. ADR 0012's rule
that a branch is named after the ticket it works for stands.

## Consequences

**This is ADR 0012's rejected alternative, taken for a different problem.**
ADR 0012 and ADR 0011 each considered "give every handoff a distinct herdr
agent name" and rejected it as the whole answer to a leftover: it hides the
leftover instead of showing it, and it breaks the one handle the operator knows
an agent by. This decision does not take that. Every name one Ticket asks for
still names that Ticket, the cycle suffix still says which of its work cycles
started the agent, and the leftover fact, its durable record, and its Close
cleanup all stand unchanged. What changes is only that two *different* Tickets
no longer ask for one name, which no leftover rule was ever meant to settle.
ADR 0043's rule - a live Agent belongs to a Ticket by its name - is what makes
the shared name a correctness failure and not just a nuisance.

**The tag is not the part an operator reads.** The tag says which Ticket a name
belongs to to the plane and to herdr, not to a person: a digest is not a handle
a human recognizes. What an operator reads is the title slug, which starts
every name, the cycle suffix, which says which work cycle started the Agent,
and the branch name, which carries the Ticket's external key. The tag costs the
title two characters of its tail, and the title is what the name is for.

**A stranger's hold on the stable name still ends the candidate search.**
`startAgentUnderAvailableName` falls to the next candidate only when the holder
is this Ticket's own Leftover environment. A name held by an Agent the plane
does not know - a second install of the plane on one herdr, an Agent the
operator named by hand, or a pre-change Agent whose Handoff row records no name
- stays a stranger, and the Handoff fails with that holder named. The tag makes
a stranger collision rare; it does not remove it. The plane keeps the failure
deliberately: a stranger's name is not this Handoff's to take, and the operator
is sent to the pane that holds it.

**Amended by ADR 0107: the settlement for a stranger collision is a fact, not a
fall-through.** This paragraph said that if a live install ever met one, the
settlement was to let a stranger collision on the stable name fall through to the
cycle names. ADR 0107 rejects that option and settles it another way, and a live
install did meet one: one Ticket re-asked 1,772 times in three hours and met the
same refusal each time. Falling through starts the Ticket under a name that is not
the one the plane derives for it, which leaves the stable name held, breaks
ADR 0043's rule that a live Agent belongs to a Ticket by its name, and says
nothing about the pane. What stands here is the search rule - a stranger ends it -
and what ADR 0107 adds is that the refusal leaves a standing fact on the Ticket,
so the re-ask waits for the operator instead of spending the Handoff limit.

**Every agent name the plane asks herdr for changes.** A Ticket whose Handoff
records carry a `herdr_name` keeps that recorded name everywhere the plane
reads it - the Live view, the Work queue, the Agent identity check, the Close
cleanup - so an agent already running stays addressable. Only a Handoff with
no recorded name falls back to the new derivation.

**An agent started before this change holds a name the plane no longer asks
for.** Its Ticket's next Handoff asks for a free name and starts beside it.
The leftover is still a fact on the Handoff row, and the Close cleanup works
on the recorded pane and workspace ids, not on the name, so the leftover
environment is still closable. What stops working is the name-collision path
for those pre-change agents: the plane no longer recognizes the old name as
the Ticket's own, so it will not report "your own leftover agent still holds
this name" for them. The development state carries 1,096 Handoff rows, 113 of
them with no recorded name; none of those 113 belongs to a Ticket in the
running or awaiting state, so no live Agent in that install is read under a
name the plane no longer derives.

**The route's name union no longer carries the case it was written for.**
`nameKnowledgeFor` unions the settled ticket's recorded handles with the
position ticket's, so a name held in the settled ticket's environment is the
route Handoff's own. An issue and its fixing pull request no longer share a
name, so that pairing cannot meet the collision. The union stands for the
shape that remains: a route Handoff works in environments both Tickets
recorded, and a holder named there is not a stranger the operator cannot act
on.

**The leftover warning keeps both names on one Message row.** The Message line
is one row of the terminal's width, and the warning a Handoff leaves beside its
own Leftover agent names two herdr names. Its wording is now `a leftover agent
holds <stable name>; this agent started as <cycle name>` so both names read
whole at 120 columns with the eight-character tag; the suite reads that warning
at the ordinary terminal width, not a wide one.

**The 32-character truncation stays a latent risk.** Two Tickets whose titles
share their first 23 slug characters now collide only if their identity
digests collide too. The tag does not remove the truncation; it makes a
collision require two coincidences instead of none.
