# ADR 0063: The review score read takes the verdict under its label line

Status: accepted
Date: 2026-09-29

## Context

ADR 0057 made the score read take the verdict line for its words, not for
its decoration: a heading marker, a list bullet, a table cell's bar, and
the emphasis runs around the label and the number all read as the same
line. The label still had to stand in the line with its number.

A review turn on `SeriousJul/pi-extensions` pull request #114 broke the
remaining gap. Its review posted the verdict under a heading: `### 3.
Score`, then a blank line, then `**92 / 100** - spec-faithful, well
tested, verified green.`. The label stood alone on its heading, and the
number stood on the line below it, bolded, with the prose after it. The
read took nothing: no line carried the label with its separator and its
number. The settle recorded the no-fire "the pull request carries no
review score", neither score branch held, and the ticket rested in its
awaiting state. The operator re-posted the verdict in the template's
fixed line, `- **Score:** 92 / 100`, and the machine routed it on the
re-fire.

The widening has one surface it must not grow: under a heading named
Score, the line below can be a verdict, a bare number in prose, a scale
written in words, a sentence that contains a number, or the numbered
list of the changes the review requires. The ADR 0057 guards hold the
in-line read to the line's own form, and the same standard applies
here: the weaker the label's claim - a label on another line is a
weaker claim than a label in the line - the stricter the line's form.

## Decision

**The read takes the verdict the label line names.** A label line is a
line whose words are the score label and nothing else: an optional
lead-in that ends in a mark, the label, and an optional separator, under
whatever markdown decoration the post wears. The verdict is the number
the next spoken line opens: the line opens with its number, the number
carries its own scale - a percent or a total - and what follows the
scale is the line's end or the line's punctuation, never a word. Blank
lines part the pair, and a spoken line between the label and its number
breaks it.

**The number line must carry its own scale.** A bare number under the
label is prose the label does not make a verdict of, a scale written in
words is not the line's own form, a number that does not open its line
is a sentence, and a numbered list under the label keeps its list. The
0 to 100 range guard and the scale to the 100 total the threshold
stands on are unchanged: a number that names its own total under the
label scales the way the same number in the fixed line scales.

**The pair decides on its number line.** The fixed line and the pair
are one timeline in the body: when both stand, the later verdict,
whatever shape it wears, is what the read takes, the way the last
occurrence in the body has always decided.

## Consequences

- The parked no-fire on the pull request #114 review is gone: the
  posted verdict reads 92, and the route over the threshold stands on
  the post the agent made, not on the operator's re-post.
- The false-positive surface grows, and it stays bounded: the label
  must stand alone on its line, the number must open its line, and the
  number must carry its own scale. A numbered list under a Score
  heading, a bare number, and a scale in words all still read as no
  score.
- The template's fixed line is still the ask, and the shipped template
  is unchanged: the plane reads the verdict wherever the agent puts
  its label, and an install's own review prompt never changes under
  this decision.
- The prose guards ADR 0057 measured are unchanged: `Score: 92 out of
  100.`, `The mutation score: 79.48 % across the slice.`, and the
  survey's prose lines still report nothing.
- The one real cycle on the twice-widened read - a settle whose posted
  verdict stands only under the label line, routed by the machine
  alone - is not measured yet. It stands in the verification record
  as it stood for the first widening.
