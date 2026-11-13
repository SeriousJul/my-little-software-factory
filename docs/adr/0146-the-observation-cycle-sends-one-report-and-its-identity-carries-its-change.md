# ADR 0146: The observation cycle sends one report, and its identity carries its change

Status: accepted
Date: 2026-11-13

Records that the observation cycle's seam to the plane sends one report
instead of the change callback and the raw agent list, that the report's
identity stands on its content - the same object across the cycles whose
content is unchanged, a new object only when the content changes - and that
the report's null roster keeps the stale agent observation marker appearing
on a failed probe without any state change. The comparison of two
consecutive probes lives in the coordinator module, the only place they
meet.

## Context

The observation cycle ends by handing its facts to the plane through two raw
callbacks:

- The change callback, which the cycle calls in a cycle that moved a Ticket
  state or a Consultation state; the plane re-derives the Ticket list and
  the Consultation list on it.
- The agent list callback, whose documented contract is to fire on every
  cycle, not only on state changes: the probe's roster on success, null
  while the probe is failing.

The every-cycle firing is not an accident of the interface; it is the seam's
failure marker. A failed probe moves nothing: no Ticket, no Consultation, no
Agent. If the plane learned of a cycle only when state moved, a failed probe
could never reach the screen, and the plane could not show its stale agent
observation - the last known standing held, the message line naming herdr
unreachable - while the condition stood. The contract exists so that a
failure marker can appear without any state change.

The plane turns both callbacks into state writes with fresh object
identity. The probe answers a fresh roster on every cycle, and the plane
stores it in its screen state on every cycle whether the roster moved or
not. The common case is an Agent sitting in a turn for minutes while the
poll runs once every five seconds: the rosters are byte-identical, yet every
cycle hands the screen a fresh array, the screen re-renders, and the
terminal repaints with no visible change.

The coordinator module already computes the comparison it throws away. It
holds the last roster, it derives on every cycle whether anything moved, and
it is the only place two consecutive probes meet. The seam exposes raw facts
whose identity means "newly allocated" rather than "changed", and the plane
cannot decide not to paint because the interface never tells it the facts
are the same. The comparison belongs in the coordinator module: it is the
only place with both sides of it, and by locality the identity rule rides on
the comparison the module already makes.

## Decision

The observation cycle's seam sends one report instead of the two raw
callbacks, and the report's identity carries its change:

- The report carries the completed cycle's facts: the probe's roster, null
  while the probe is failing; the Agents that moved between the two
  consecutive probes; and the cycle's movement of the Ticket states and the
  Consultation states, the same fact the change callback carried.
- While the report's content is unchanged, the coordinator hands back the
  same report object as the previous cycle; only a change earns a new
  object. The content comparison runs inside the coordinator module, the
  only place two consecutive probes meet, beside the roster comparison it
  already holds and the movement fact it already derives.
- The probe failure fact survives the new shape: the failing cycle reports
  the null roster and no movement, so the stale agent observation marker can
  appear without any state change, the documented contract preserved. Two
  consecutive failing probes report the same object.
- The plane applies the report only on new identity: it stores the report it
  last applied, writes the facts a new report names into its existing screen
  state, and writes nothing on a matching identity - no state write, no
  commit, no paint. The host fact the plane derives from the roster is
  rebuilt with the roster, not on a quiet cycle.
- The seam loses the change callback and the agent list callback and gains
  the report callback. The poll cadence and its one list call per cycle
  stand (ADR 0006), the agent-wait wake stands (ADR 0084), and the cycle's
  flow - probe, settle, dispatch, top-up - is unchanged. The decision
  changes only what the seam reports and who compares: the coordinator
  compares, and the plane writes on identity.

## Considered options

- Compare on the plane side: the plane holds the last roster it stored and
  skips the write when the new roster's content equals it. The comparison
  sits in the module that sees only one probe at a time; the before and the
  after live in the coordinator. A comparison in the plane re-derives what
  the coordinator already knows, and every future reader of the cycle's
  facts repeats the same check. The deep module holds both sides; the
  shallow reader should trust its report.
- Drop the failure marker: fire the callback only on change and delete the
  every-cycle contract. A failed probe moves nothing, so the plane could
  never show its stale agent observation, and the last known standing could
  be read as missing. The glossary names the condition for a reason; the
  seam keeps it.
- A change-event enumeration instead of identity: the report names which
  facts moved, and the plane writes the sections the event names. The event
  is a fresh object on every cycle, and the roster the plane stores rides on
  it fresh, so the re-render the decision kills comes back on the quiet
  cycle. Identity stability is the skip signal, and it must be owned by the
  sender that compares.

## Consequences

- In the steady state the quiet observation cycle costs the plane one
  identity check and nothing on the terminal: no state write, no commit, no
  paint. The base screen stands still for the whole turn an Agent sits in,
  and the operator's screen changes only when a fact changes.
- The plane loses the two raw callbacks and the write-per-cycle habit; it
  gains one rule - apply on new identity - and a report whose facts name the
  movement, so a write reaches only the sections that moved.
- The tests must show the rule at both seams: at the coordinator's seam, a
  probe sequence answers with the report's identity and content - the same
  object across unchanged cycles, a new one on a move, the null roster on a
  failing probe, the same object across consecutive failures; at the
  plane's seam, a quiet cycle lands no frame and the screen stands
  byte-identical, and a failing probe paints the failure marker with no
  other change.
- Beside the renderer's repaint policy (ADR 0145): with the diffing write
  restored, a no-op report costs the plane one identity check and nothing on
  the terminal; without it, the quiet cycle still lands no frame, but the
  plane's other ticks still rewrite the whole screen, so the visible win
  stands partial until that decision lands.
- The coordinator keeps its own read of the last roster beside the report:
  the report changes what the seam hands over, not what the module keeps for
  its tests.
