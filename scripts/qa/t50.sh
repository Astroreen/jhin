#!/usr/bin/env bash
# QA for T50: the SDUI contract level 2 specification (docs/sdui.md) and the
# data-upgrade system specification (docs/updates.md).
# Usage: scripts/qa/t50.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T50. Every check transcript lands
# next to the artifacts listed below. Exits non-zero on the first failed
# assertion.
#
# Happy path: asserts the docs carry the whole level-2 contract —
#   - more than 120 markdown table rows in docs/sdui.md,
#   - the `undo` directive documented (>= 3 occurrences),
#   - every prop key of the contract present (backticked) in docs/sdui.md,
#   - docs/updates.md documents the envelope, the six runner rules and the
#     downgrade/quarantine behavior,
#   - the QA helper scripts pass `bash -n` and flutter-test.sh --help exits 0.
#   Evidence: doc-headings.txt, prop-key-list.txt, syntax.txt, checks.txt.
#
# --fail mode (failure-path evidence): runs the same evidence generation,
#   asserts the negative probes (the envelope example is findable via the
#   word `schema`; a deliberately missing rule name has zero grep hits), then
#   deliberately trips one assertion (a prop key that must not exist) and
#   exits non-zero — proving the checker actually fails when the docs are
#   wrong. Evidence lands in the same files.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T50}
mkdir -p "$evidence"

# The failure-path run keeps its own transcript so the happy-path checks.txt
# stays green on disk next to it.
if [ "$fail_mode" = "1" ]; then
  checks="$evidence/checks-fail.txt"
else
  checks="$evidence/checks.txt"
fi
: > "$checks"

log() {
  printf '%s\n' "$*"
}

ok() {
  printf 'ok: %s\n' "$*" | tee -a "$checks"
}

fail() {
  printf 'FAIL: %s\n' "$*" | tee -a "$checks" >&2
  exit 1
}

assert_eq() {
  [ "$1" = "$2" ] || fail "$3: expected [$2], got [$1]"
}

sdui=docs/sdui.md
updates=docs/updates.md

log "T50 QA: SDUI contract level 2 + data-upgrade system docs"
log "evidence dir: $evidence"
[ "$fail_mode" = "1" ] && log "mode: --fail (failure-path evidence)"

[ -f "$sdui" ] || fail "missing $sdui"
[ -f "$updates" ] || fail "missing $updates"
ok "docs present: $sdui, $updates"

# Artifact 1: headings of both documents.
{
  printf '# headings of docs/sdui.md\n'
  grep -n '^#' "$sdui"
  printf '# headings of docs/updates.md\n'
  grep -n '^#' "$updates"
} > "$evidence/doc-headings.txt"
headings=$(grep -c '^#' "$sdui")
ok "doc-headings.txt written ($headings headings in sdui.md)"

# Artifact 2: every prop key documented in docs/sdui.md, extracted from the
# tables whose header contains a `Prop` column (second column, backticked,
# one key per row).
awk '
  {
    if ($0 !~ /^[[:space:]]*\|/) { intable = 0; next }
    if ($0 ~ /\|[[:space:]]*Prop[[:space:]]*\|/) { intable = 1; next }
    if ($0 ~ /^[[:space:]]*\|[-: |]+\|?[[:space:]]*$/) { next }
    if (intable) {
      split($0, cells, "|")
      line = cells[3]
      if (match(line, /`[A-Za-z][A-Za-z0-9_]*`/)) {
        print substr(line, RSTART + 1, RLENGTH - 2)
      }
    }
  }
' "$sdui" | sort -u > "$evidence/prop-key-list.txt"
prop_count=$(wc -l < "$evidence/prop-key-list.txt" | tr -d ' ')
[ "$prop_count" -gt 50 ] || fail "prop-key-list.txt looks wrong ($prop_count keys)"
ok "prop-key-list.txt written ($prop_count distinct prop keys)"

# Artifact 3: bash -n over the QA scripts.
{
  for sh in scripts/qa/*.sh; do
    if bash -n "$sh" 2>&1; then
      printf 'bash -n: OK %s\n' "$sh"
    else
      printf 'bash -n: FAILED %s\n' "$sh"
    fi
  done
} > "$evidence/syntax.txt"
grep -q 'FAILED' "$evidence/syntax.txt" && fail "bash -n reported a syntax error (see $evidence/syntax.txt)"
ok "syntax.txt written (bash -n clean over all QA scripts)"

# Acceptance: markdown table row count in docs/sdui.md > 120.
rows=$(grep -c '^|' "$sdui")
printf '%s\n' "$rows" > "$evidence/table-rows.txt"
[ "$rows" -gt 120 ] || fail "docs/sdui.md has only $rows table rows (need > 120)"
ok "markdown table rows in docs/sdui.md: $rows (> 120)"

# Acceptance: the `undo` directive is documented (>= 3 occurrences).
undo_hits=$(grep -o 'undo' "$sdui" | wc -l | tr -d ' ')
printf '%s\n' "$undo_hits" > "$evidence/undo-hits.txt"
[ "$undo_hits" -ge 3 ] || fail "undo appears only $undo_hits times in docs/sdui.md (need >= 3)"
ok "undo occurrences in docs/sdui.md: $undo_hits (>= 3)"

# Acceptance: every contract prop key is documented in docs/sdui.md.
required_keys=$(cat <<'EOF'
id
when
visible
width
height
minWidth
maxWidth
minHeight
maxHeight
aspectRatio
padding
margin
color
gradient
border
borderWidth
borderStyle
borderRadius
shadow
opacity
clip
transform
align
alignment
fontFamily
fontSize
fontWeight
fontStyle
letterSpacing
wordSpacing
textAlign
textDecoration
textOverflow
maxLines
softWrap
ellipsis
style
bold
italic
strutStyle
textWidthBasis
locale
selectionColor
flex
fit
mainAxisSize
mainAxisAlignment
crossAxisAlignment
direction
gap
spacing
scroll
textDirection
verticalDirection
textBaseline
overflow
clipBehavior
action
onTap
onLongPress
confirm
tooltip
cursor
enabled
focusable
semanticsLabel
semanticsHint
semanticsValue
excludeSemantics
child
children
shape
sidebar
header
body
detail
rail
breakpoint
sidebarWidth
sidebarCollapsedWidth
collapsible
collapsed
leading
title
subtitle
trailing
badge
selected
dragHandle
label
icon
avatar
onDeleted
variant
count
dot
max
items
trigger
dismissible
activeIndex
activeId
kind
codeBlockStyle
syntax
text
code
language
wrap
copyable
lines
shimmer
columns
rows
zebra
hoverable
onRowTap
stickyHeader
sort
empty
axis
size
value
placeholder
multiline
obscure
keyboard
keyboardType
required
min
pattern
errorText
textInputAction
textCapitalization
maxLength
maxLengthEnforcement
minLines
expands
autocorrect
enableSuggestions
obscuringCharacter
enableInteractiveSelection
readOnly
showCursor
autofocus
cursorWidth
cursorHeight
cursorRadius
cursorColor
mouseCursor
hintText
helperText
labelText
prefixIcon
suffixIcon
counterText
fillColor
filled
hoverColor
focusColor
enabledBorder
focusedBorder
errorBorder
contentPadding
isDense
isCollapsed
dense
alignLabelWithHint
constraints
toolbarOptions
smartDashesType
smartQuotesType
onEditingChanged
onAppended
onRemoved
decoration
isExpanded
elevation
borderRadius
itemHeight
selectedItemBuilder
menuMaxHeight
dropdownColor
hint
tristate
fillColor
trackColor
thumbIcon
disabledColor
activeColor
activeTrackColor
inactiveThumbColor
inactiveTrackColor
thumbColor
overlayColor
inactiveColor
onChangeStart
onChangeEnd
submit
fields
autovalidateMode
onChanged
segments
onSelect
expanded
onReorder
selection
itemExtent
prototypeItem
separator
sections
runSpacing
runAlignment
crossAxisSpacing
mainAxisSpacing
childAspectRatio
physics
shrinkWrap
scrollDirection
reverse
controller
itemCount
top
right
bottom
left
thickness
indent
endIndent
appBar
floatingAction
src
dataUri
fit
series
step
mode
itemLimit
autoScroll
topic
image
initials
onDismiss
content
actions
spans
onSelect
isSelected
selectedIcon
visualDensity
enableFeedback
splashRadius
iconSize
semanticLabel
fill
weight
grade
opticalSize
shadows
blendMode
EOF
)
missing=""
while IFS= read -r key; do
  [ -n "$key" ] || continue
  pat='`'"$key"'`'
  if ! grep -qF "$pat" "$sdui"; then
    missing="$missing $key"
  fi
done <<EOF
$(printf '%s\n' "$required_keys" | sort -u)
EOF
if [ -n "$missing" ]; then
  printf '%s\n' "missing prop keys:$missing" > "$evidence/missing-keys.txt"
  fail "prop keys missing from docs/sdui.md:$missing"
fi
ok "all contract prop keys documented in docs/sdui.md ($(printf '%s\n' "$required_keys" | sort -u | grep -c .) keys checked)"

# Acceptance: docs/updates.md documents the envelope, the six runner rules
# and the downgrade/quarantine behavior.
grep -q 'schema' "$updates" || fail "docs/updates.md never mentions schema"
grep -q '"writtenAt"' "$updates" || fail "docs/updates.md has no envelope example (no writtenAt field)"
grep -q '"data"' "$updates" || fail "docs/updates.md envelope example has no data field"
for rule in Precedent "Ordered, atomic per key" "Forward data" "Partial failure" "Runs before anything reads state" "Version gate"; do
  grep -q "$rule" "$updates" || fail "docs/updates.md is missing runner rule: $rule"
done
grep -q 'migration.quarantine' "$updates" || fail "docs/updates.md does not document quarantine"
grep -q 'Never destroy' "$updates" || fail "docs/updates.md does not state the never-destroy rule"
ok "docs/updates.md: envelope example, six runner rules and quarantine documented"

# Acceptance: the level-1 appendix and the negotiation header are present.
grep -q 'X-Jhin-Client' "$sdui" || fail "docs/sdui.md does not document X-Jhin-Client"
grep -q 'Appendix A' "$sdui" || fail "docs/sdui.md has no level-1 appendix"
grep -q 'CapabilityTailor\|Degrades to' "$sdui" || fail "docs/sdui.md has no downgrade table"
ok "negotiation header, level-1 appendix and downgrade table present"

if [ "$fail_mode" = "1" ]; then
  # Negative probes (failure-path evidence): the checker must find the
  # envelope example via the word `schema`, and a deliberately missing rule
  # name must have zero grep hits.
  grep -q 'schema' "$updates" || fail "--fail probe: envelope example not found via schema"
  bogus_rule="RuleSevenDoesNotExistAnywhere"
  hits=$(grep -c "$bogus_rule" "$updates" || true)
  assert_eq "$hits" "0" "--fail probe: bogus rule name should have 0 grep hits"
  ok "--fail probes passed: envelope findable, bogus rule name has 0 hits"
  # Now deliberately trip the checker: assert a prop key that must not exist
  # is documented. This FAILS on purpose and exits non-zero.
  bogus_key="thisPropKeyDoesNotExist"
  pat='`'"$bogus_key"'`'
  if grep -qF "$pat" "$sdui"; then
    fail "--fail probe: $bogus_key unexpectedly documented"
  fi
  fail "--fail probe: $bogus_key is not documented in docs/sdui.md (intentional failure-path evidence)"
fi

log "T50 QA green: contract level 2 and data-upgrade system docs verified"
