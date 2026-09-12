#!/bin/bash
# tmux acceptance run for the merged Main view (PR 42). Version 2:
# seeded Consultations, a live issue source for the Ticket list, and a
# shadowed herdr so the observation loop holds instead of touching agents.
# Every check prints PASS or FAIL. No check can launch real work.
set -u
WT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$WT"
ACC="${TMPDIR:-/tmp}/factory-acc"
SESSION=factory-acc
SHOTS="$ACC/shots"
CFG="$ACC/config.toml"
DB="$ACC/state.sqlite"
PASS=0
FAIL=0

# The config must name real repositories and task types; adjust the gh
# source and repositories for the machine that runs the check.
if [ ! -f "$CFG" ]; then
	echo "write $CFG first: a valid factory config with a live source"
	exit 2
fi

mkdir -p "$SHOTS" "$ACC/bin"
rm -f "$SHOTS"/*.txt
# The shadowed herdr refuses every call, so the observation loop holds and
# the seeded Consultations stay exactly where the seed left them.
printf '#!/bin/sh\nexit 1\n' > "$ACC/bin/herdr"
chmod +x "$ACC/bin/herdr"
rm -f "$DB"

# --- seed two inert Consultations (awaiting response, no real Agent) ---
# The state database is created by the app's own migration, so the seed
# inserts rows into the real schema instead of a hand-made copy.
NODE_OPTIONS=--experimental-ffi node --input-type=module -e "
const { openFactoryState } = await import('./src/state.ts');
const state = openFactoryState('$DB');
state.close();
console.log('state database initialized');
"
python3 - "$DB" <<'EOF'
import sqlite3, sys, uuid, datetime
db = sys.argv[1]
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
con = sqlite3.connect(db)
for n in (1, 2):
    con.execute(
        "INSERT INTO consultations (id, type_name, agent_type, environment, model, thinking,"
        " template, initial_input, rendered_opening_prompt, repository_identity,"
        " repository_display_name, repository_clone_url, repository_path, state, created_at,"
        " updated_at, agent_name, pane_id, tab_id, workspace_id, session_id, latest_sequence,"
        " draft, draft_updated_at, draft_old, failure, warning, replacement_of, close_result,"
        " live_conflict_override, attention_at, context_window) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? )",
        (
            str(uuid.uuid4()), "grill", "pi", "worktree", "", "", "/grill {input}",
            f"Seeded acceptance consultation {n}",
            f"/grill Seeded acceptance consultation {n}",
            "github.com/seriousjul/pi-extensions", "seriousjul/pi-extensions",
            "https://github.com/seriousjul/pi-extensions.git",
            "/home/seriousjul/src/pi-extensions", "awaiting-response", now, now,
            f"consultation-acc{n:04d}", None, None, None, None, None, "", None, 0,
            None, None, None, None, 0, None, "",
        ),
    )
    # A minute apart, so the two rows carry different start times.
    if n == 1:
        con.execute(
            "UPDATE consultations SET created_at = ? WHERE agent_name = 'consultation-acc0001'",
            (datetime.datetime.now(datetime.timezone.utc)
             .strftime("%Y-%m-%dT%H:%M:%S.000Z"),),
        )
con.commit()
con.close()
print("seeded 2 consultations")
EOF

shot() {
	local frame
	frame="$(tmux capture-pane -t "$SESSION" -p)"
	printf '%s\n' "$frame" > "$SHOTS/$2.txt"
	printf '%s' "$frame"
}

# The line of the list's row marker, ignoring the pane title marker.
marker_line() {
	tmux capture-pane -t "$SESSION" -p | grep -n '❯' | grep -v '┌─' | head -1 | cut -d: -f1
}

# Wait until two captures 400 ms apart agree: the frame is quiescent.
wait_stable() {
	local a b i
	for ((i = 0; i < 25; i += 1)); do
		a="$(tmux capture-pane -t "$SESSION" -p)"
		sleep 0.4
		b="$(tmux capture-pane -t "$SESSION" -p)"
		[ "$a" = "$b" ] && return 0
	done
	return 1
}

wait_for() { # target regex seconds
	local target="$1" re="$2" secs="${3:-10}"
	local i frame
	for ((i = 0; i < secs * 10; i += 1)); do
		frame="$(tmux capture-pane -t "$target" -p)"
		if printf '%s' "$frame" | grep -qE "$re"; then
			printf '%s\n' "$frame" > "$SHOTS/wait-$target.txt"
			return 0
		fi
		sleep 0.1
	done
	printf '%s\n' "$(tmux capture-pane -t "$target" -p)" > "$SHOTS/wait-$target-fail.txt"
	return 1
}

check() { # name ok(0=pass)
	if [ "$2" -eq 0 ]; then
		PASS=$((PASS + 1)); echo "PASS: $1"
	else
		FAIL=$((FAIL + 1)); echo "FAIL: $1"
	fi
}

tmux kill-session -t "$SESSION" 2>/dev/null
tmux new-session -d -s "$SESSION" -x 120 -y 24 -c "$WT"

# The pane's PATH shadows herdr but keeps gh, pi, and node.
tmux send-keys -t "$SESSION" 'export PATH='"$ACC"'/bin:$PATH' Enter
sleep 0.3
tmux send-keys -t "$SESSION" "NODE_OPTIONS=--experimental-ffi node src/factory.ts --config $CFG" Enter

# R1: the merged Main view renders both sections, one action bar, two panes.
if wait_for "$SESSION" 'Consultations' 25; then
	frame="$(cat "$SHOTS/wait-$SESSION.txt")"
	ok=0
	printf '%s' "$frame" | grep -q '▾ Tickets' || ok=1
	printf '%s' "$frame" | grep -q '▸ Consultations' || ok=1
	[ "$(printf '%s' "$frame" | grep -c '? Help')" -eq 1 ] || ok=1
	[ "$(printf '%s' "$frame" | grep -o '┌─' | wc -l)" -eq 2 ] || ok=1
	check "R1 rendering: both section headers, one action bar, two panes (120x24)" $ok
else
	check "R1 rendering: both section headers, one action bar, two panes (120x24)" 1
fi

# R2: the terminal protocol requests color on a 256-color terminal.
tmux capture-pane -t "$SESSION" -p -e > "$SHOTS/r2-color.txt"
grep -q $'\x1b\[' "$SHOTS/r2-color.txt"; check "R2 rendering: SGR color output on a 256-color terminal" $?

# K1: the section keys collapse the other section of the one surface.
tmux send-keys -t "$SESSION" v
sleep 0.5
frame="$(shot 0 k1-consultations)"
ok=0
printf '%s' "$frame" | grep -q '▸ Tickets' || ok=1
printf '%s' "$frame" | grep -q '▾ Consultations' || ok=1
check "K1 keyboard: v expands Consultations, collapses Tickets" $ok
tmux send-keys -t "$SESSION" t
sleep 0.5
frame="$(shot 0 k1-tickets)"
ok=0
printf '%s' "$frame" | grep -q '▾ Tickets' || ok=1
printf '%s' "$frame" | grep -q '▸ Consultations' || ok=1
check "K1 keyboard: t expands Tickets, collapses Consultations" $ok

# K2: j/k move the Ticket list marker one row down and back.
# Wait until the live source has delivered at least two Ticket rows.
i=0
while [ $i -lt 60 ]; do
	frame="$(tmux capture-pane -t "$SESSION" -p)"
	[ "$(printf '%s' "$frame" | grep -cE '^│ (❯ |  )\[open\]')" -ge 2 ] && break
	sleep 0.5; i=$((i + 1))
done
frame="$(shot 0 k2-tickets)"
if [ "$(printf '%s' "$frame" | grep -cE '^│ (❯ |  )\[open\]')" -ge 2 ]; then
	wait_stable
	before="$(marker_line)"
	tmux send-keys -t "$SESSION" j
	sleep 0.4
	after="$(marker_line)"
	tmux send-keys -t "$SESSION" k
	sleep 0.4
	back="$(marker_line)"
	ok=0
	[ "$after" = "$((before + 1))" ] || ok=1
	[ "$back" = "$before" ] || ok=1
	check "K2 keyboard: j/k move the Ticket list marker down and back" $ok
else
	check "K2 keyboard: j/k move the Ticket list marker down and back" 1
fi

# K3: the detail pane takes the focus marker.
tmux send-keys -t "$SESSION" l
sleep 0.4
frame="$(shot 0 k3-detail)"
ok=0
printf '%s' "$frame" | grep -q '❯ Detail' || ok=1
check "K3 focus: l moves the focus marker to the detail pane" $ok

# K4: F1 opens the Key guide, Escape closes it.
tmux send-keys -t "$SESSION" F1
sleep 0.5
frame="$(shot 0 k4-keyguide)"
ok=0
printf '%s' "$frame" | grep -q 'Key guide' || ok=1
tmux send-keys -t "$SESSION" Escape
sleep 0.5
frame="$(shot 0 k4-closed)"
ok=$ok
printf '%s' "$frame" | grep -q 'Key guide' && ok=1
printf '%s' "$frame" | grep -q '? Help' || ok=1
check "K4 keyboard: F1 opens the Key guide, Escape closes it" $ok

# E1: with an open Ticket selected, e opens the Override panel.
tmux send-keys -t "$SESSION" e
sleep 0.8
frame="$(shot 0 e1-override)"
ok=0
printf '%s' "$frame" | grep -q 'Override' || ok=1
check "E1 focus: e opens the Override panel on the Ticket" $ok

# E2: five rows down is the Context token field.
for ((i = 0; i < 5; i += 1)); do
	tmux send-keys -t "$SESSION" Down
	sleep 0.15
done
frame="$(shot 0 e2-context-row)"
ok=0
printf '%s' "$frame" | grep -E '❯ .*Context' >/dev/null || ok=1
check "E2 keyboard: Down walks the Override rows to the Context field" $ok

# E3: a pasted token keeps its digits and refuses the letters.
tmux send-keys -t "$SESSION" -l $'\x1b[200~12ab34\x1b[201~'
sleep 0.5
frame="$(shot 0 e3-paste-digits)"
ok=0
printf '%s' "$frame" | grep -q '1234' || ok=1
printf '%s' "$frame" | grep -q '12ab34' && ok=1
check "E3 paste: the Context field keeps 1234 and refuses the letters" $ok

# E4: caret edges and undo/redo in the same field.
tmux send-keys -t "$SESSION" Home
sleep 0.3
tmux send-keys -t "$SESSION" -l "9"
sleep 0.3
tmux send-keys -t "$SESSION" End
sleep 0.3
tmux send-keys -t "$SESSION" -l "9"
sleep 0.4
frame="$(shot 0 e4-caret-edges)"
ok=0
printf '%s' "$frame" | grep -q '912349' || ok=1
check "E4 keyboard: Home and End put the caret at each edge (912349)" $ok
tmux send-keys -t "$SESSION" C-z
sleep 0.3
tmux send-keys -t "$SESSION" C-z
sleep 0.4
frame="$(shot 0 e4-undo)"
ok=0
printf '%s' "$frame" | grep -q '912349' && ok=1
printf '%s' "$frame" | grep -q '1234' || ok=1
check "E4 keyboard: Ctrl+Z twice undoes the two typed digits" $ok
tmux send-keys -t "$SESSION" C-y
sleep 0.3
tmux send-keys -t "$SESSION" C-y
sleep 0.4
frame="$(shot 0 e4-redo)"
ok=0
printf '%s' "$frame" | grep -q '912349' || ok=1
check "E4 keyboard: Ctrl+Y twice redoes them" $ok

# E5: Escape closes the panel and restores the Main view.
# The action bar keeps the "e Override" key label, so the panel's pane
# title is the marker of the panel itself.
tmux send-keys -t "$SESSION" Escape
sleep 0.5
frame="$(shot 0 e5-closed)"
ok=0
printf '%s' "$frame" | grep -q '┌─Override' && ok=1
printf '%s' "$frame" | grep -q '? Help' || ok=1
check "E5 focus: Escape closes the Override panel, main view restored" $ok

# K5: the Consultations list walks between the two seeded rows.
tmux send-keys -t "$SESSION" v
sleep 0.5
frame="$(shot 0 k5-consultations)"
ok=0
printf '%s' "$frame" | grep -c 'awaiting-response' | grep -qE '^2$|^3$' || ok=1
check "K5 keyboard: v expands Consultations with both seeded rows" $ok
b5="$(marker_line)"
tmux send-keys -t "$SESSION" j
sleep 0.4
a5="$(marker_line)"
ok=0
[ "$a5" = "$((b5 + 1))" ] || ok=1
check "K5 keyboard: j moves the Consultation marker to the second row" $ok

# P1: the launcher opens with its field rows.
tmux send-keys -t "$SESSION" c
sleep 0.6
frame="$(shot 0 p1-launcher)"
ok=0
printf '%s' "$frame" | grep -q '❯ Type' || ok=1
check "P1 paste: the launcher opens with its field rows" $ok

# P2: typed text lands in the draft and the byte count follows.
tmux send-keys -t "$SESSION" Down
tmux send-keys -t "$SESSION" Down
sleep 0.4
tmux send-keys -t "$SESSION" -l "scroll the detail"
sleep 0.5
frame="$(shot 0 p2-typed)"
ok=0
printf '%s' "$frame" | grep -q 'scroll the detail' || ok=1
printf '%s' "$frame" | grep -q 'UTF-8 bytes: 17/65536' || ok=1
check "P2 paste: typed text lands in the draft, byte count says 17" $ok

# P3: a bracketed paste with Unicode lands whole, byte count exact.
# "scroll the detail" is 17 bytes; " café ✓" is 10 more (é 2, ✓ 3).
tmux send-keys -t "$SESSION" -l $'\x1b[200~ café ✓\x1b[201~'
sleep 0.5
frame="$(shot 0 p3-pasted)"
ok=0
printf '%s' "$frame" | grep -q 'scroll the detail café ✓' || ok=1
printf '%s' "$frame" | grep -q 'UTF-8 bytes: 27/65536' || ok=1
check "P3 paste: bracketed Unicode paste lands, byte count says 27" $ok

# P4: shift+Enter in the draft is a newline; plain Enter never runs.
tmux send-keys -t "$SESSION" S-Enter
sleep 0.5
frame="$(shot 0 p4-newline)"
ok=0
printf '%s' "$frame" | grep -q 'UTF-8 bytes: 28/65536' || ok=1
printf '%s' "$frame" | grep -q '❯ Initial input' || ok=1
check "P4 paste: shift+Enter in the draft is a newline, not a submit" $ok

# P5: Escape closes the launcher without launching anything.
tmux send-keys -t "$SESSION" Escape
sleep 0.5
frame="$(shot 0 p5-closed)"
ok=0
printf '%s' "$frame" | grep -q 'Initial input' && ok=1
printf '%s' "$frame" | grep -q '? Help' || ok=1
check "P5 focus: Escape closes the launcher, main view intact" $ok

# F1: no captured frame ever drew more than one focus marker per surface.
bad=""
for f in "$SHOTS"/*.txt; do
	n="$(grep -o '❯' "$f" | wc -l)"
	if [ "$n" -gt 2 ]; then bad="$bad $(basename "$f")=$n"; fi
done
ok=1
[ -z "$bad" ] && ok=0
check "F1 focus: no frame drew more than two focus markers$bad" $ok

# R3: a narrow terminal lays the Consultation section out as one pane.
tmux resize-window -t "$SESSION" -x 60 -y 12
sleep 0.6
frame="$(shot 0 r3-narrow)"
ok=0
printf '%s' "$frame" | grep -q '▾ Consultations' || ok=1
[ "$(printf '%s' "$frame" | grep -o '┌─' | wc -l)" -eq 1 ] || ok=1
check "R3 rendering: 60x12 lays Consultations out as one pane" $ok

# R4: below the minimum size the process survives.
tmux resize-window -t "$SESSION" -x 30 -y 8
sleep 0.6
shot 0 r4-tiny >/dev/null
pgrep -f "factory-acc/config.toml" >/dev/null; check "R4 rendering: 30x8 below the minimum keeps the process alive" $?

# X1: Ctrl+C is the emergency exit.
tmux resize-window -t "$SESSION" -x 120 -y 24
sleep 0.4
tmux send-keys -t "$SESSION" C-c
i=0
while [ $i -lt 150 ]; do
	pgrep -f "factory-acc/config.toml" >/dev/null || break
	sleep 0.1; i=$((i + 1))
done
shot 0 x1-exited >/dev/null
if pgrep -f "factory-acc/config.toml" >/dev/null; then ok=1; else ok=0; fi
check "X1 keyboard: Ctrl+C exits the control plane" $ok

# R5 (informational): a terminal without 256-color support.
SESSION2=factory-acc-nocolor
tmux kill-session -t "$SESSION2" 2>/dev/null
tmux new-session -d -s "$SESSION2" -x 120 -y 24 -c "$WT"
tmux send-keys -t "$SESSION2" 'export PATH='"$ACC"'/bin:$PATH' Enter
sleep 0.3
tmux send-keys -t "$SESSION2" "TERM=vt100 NODE_OPTIONS=--experimental-ffi node src/factory.ts --config $CFG" Enter
if wait_for "$SESSION2" 'Consultations' 25; then
	tmux capture-pane -t "$SESSION2" -p -e > "$SHOTS/r5-nocolor.txt"
	sgr="$(grep -c $'\x1b\[' "$SHOTS/r5-nocolor.txt")"
	echo "INFO: R5 no-color terminal (TERM=vt100): $sgr SGR sequences in the capture"
	tmux send-keys -t "$SESSION2" C-c
	sleep 1
else
	echo "INFO: R5 no-color terminal (TERM=vt100): app did not render the section headers"
fi

tmux kill-session -t "$SESSION" 2>/dev/null
tmux kill-session -t "$SESSION2" 2>/dev/null
echo
echo "tmux acceptance: $PASS passed, $FAIL failed"
exit $FAIL
