# ADR 0057: The review score read takes the verdict line under its markdown

Status: accepted
Date: 2026-09-24

## Context

ADR 0053 made the score judgment decide on the newest record of the pull
request's two verdict timelines that carries the template's fixed score line.
The read took the line's words and one spelling of them: `\*\*Score:\*\*`, the
bold the seed template writes in its Output Format.

A review agent posts that line under the markdown its own hand picks. Two
real review turns on `SeriousJul/my-little-software-factory` pull request #157
posted their verdict as a heading, and the read took nothing from either: the
review of 2026-09-23T19:58:07Z wrote `## Score: 83 / 100`, and the review of
2026-09-23T22:07:40Z wrote `# Score: 85 / 100`. Both settles recorded the
no-fire "the pull request carries no review score", neither score branch
held, no label was written, and the pull request rested in the turn's
awaiting state for the operator's hand. The third review on the same pull
request posted `- **Score:** 95 / 100`, the one spelling the read knew, and
the machine routed it. A survey of the verdicts posted on the three
repositories the development machine works found the fixed line under a
heading six times, and every one of them read as no score.

The same survey showed the line worn other ways the read also misses: the
colon inside the bold rather than outside it (`**Score: 85 / 100**`), the
number bolded and the label plain (`Score: **88/100**`), the line as a table
cell (`| **Score:** 84 / 100 |`), and the qualified label
(`**Review score:** 90 / 100`).

The read had one gap of its own beside the pattern. Each verdict timeline is
one page: `?per_page=100`, no walk. GitHub answers a comment list and a review
list oldest first, so on a pull request with more than a hundred comments or
reviews the plane reads the first hundred records and never sees the verdict
the thread posted last: the newest-record rule decides on a list that cannot
hold the newest record. The security feeds read their lists with
`gh api --paginate` for exactly this reason, and the verdict reads never got
the walk.

The line's words are still the contract, and the reason is ADR 0053's: a
number in loose prose is not the agent's verdict. The survey's own
counter-examples are the guard. `The mutation score: 79.48 % across the
slice.` names its number after a word, and `Score: 92 out of 100.` writes its
scale in words instead of in the line's own form. Neither is a posted verdict
line, and the read takes neither.

## Decision

**The score read takes the verdict line for its words, not for its
decoration.** The line is the score label, its separator, and its number. The
read takes the markdown a post wears in front of the line (a heading marker, a
list bullet, a quote marker, a table cell's bar) and inside it (the emphasis
runs around the label, around the separator, and around the number) as
decoration, and then reads the label, its separator (`:`, `=`, or the bar of
the cell that holds it), and the number. The scale is `%` or `/ 100` in either
spacing, and a line that names another total scales to the 100 the threshold
stands on, so `Score: 18 / 20` is 90.

**The label still decides what is a score line.** The line carries its label at
the line's start, or after a lead-in that ends in a mark, and the number
carries the line's own scale or nothing after it but the line's punctuation.
A score named in prose reports no score, exactly as before. The newest-record
rule across both timelines, the last-occurrence rule within one body, and the
0 to 100 range guard are unchanged.

**Each verdict timeline is read whole.** The comment read and the review read
each walk every page of its list, and the judgment sorts the records the two
walks collected. The reads stay two, gated the way ADR 0053 gates them, and
each still fails open on its own timeline.

## Consequences

- A verdict posted as a heading, a table cell, or with its colon inside the
  bold decides the branch: the parked no-fire on a decoration-posted score is
  gone, and the turn that posted it routes the pull request the way the
  template's own bold does. The two #157 turns are the measured case.
- On a pull request with more than 100 comments or reviews, the newest
  verdict stands in the list the judgment sorts. A long thread costs the walk
  its pages, and no fire pays for a timeline it does not read.
- The shipped template is unchanged and stays the ask: the plane reads the
  line wherever an agent puts its decoration, and an install's own review
  prompt never changes under this decision.
- The read still takes one verdict line per record, the last one in the body,
  and it still ignores a scale written in words. A review that reports its
  score only as prose reports nothing, and the fire records the no-fire the
  way ADR 0053's reason does.
- A score the read cannot find routes nothing: the fire records "the pull
  request carries no review score", and the Decision region's re-fire row
  stands on that outcome (ADR 0054).
