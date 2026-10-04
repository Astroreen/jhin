# T82 golden diffs

Golden review (pixel probes, golden-review.txt) flagged 0 wrong-looking
goldens: 13 sampled, 13 OK. So there is no per-flagged-golden diff to record.

The one artifact here is the failure-path probe of `scripts/qa/t82.sh --fail`:
the committed light baseline of `fixture-text-basic-light` was temporarily
replaced with its dark counterpart (a temp-backup swap, baseline restored
byte-identical to HEAD afterwards and verified clean via `git diff`), the
golden suite was run and correctly failed, and Flutter's isolated-diff
artifact was copied in as `fixture-text-basic-light_isolatedDiff.png`. It
proves the harness detects baseline corruption; it is not a product diff.
