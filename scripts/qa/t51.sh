#!/usr/bin/env bash
# QA for T51: the SDK scheduler seam, client schema parsing and contract
# constants.
# Usage: scripts/qa/t51.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T51. Exits non-zero on the first
# failed assertion.
#
# Happy path:
#   - runs ./gradlew :sdk:test (the SDK module is the included build named
#     `sdk` in settings.gradle) and requires BUILD SUCCESSFUL,
#   - compiles and runs a tiny probe against the built SDK classes; the probe
#     prints the full X-Jhin-Client parse matrix (actual parsed values) into
#     parse-matrix.txt and the garbage/unknown-key fallbacks plus the
#     SchedulerRegistry contract probes into negative.txt.
#   Evidence: test.txt, parse-matrix.txt, negative.txt, checks.txt.
#
# --fail mode (failure-path evidence): regenerates the same evidence, asserts
#   the negative probes still hold (fallbacks to 1, cancel("missing") false),
#   then deliberately trips a wrong expectation (parse("api=abc") asserted to
#   be 7) and exits non-zero — proving the checker actually fails when the
#   SDK behaves differently. Evidence lands in the same files.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T51}
mkdir -p "$evidence"

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

log "T51 QA: SDK scheduler seam, client schema parsing, contract constants"
log "evidence dir: $evidence"
[ "$fail_mode" = "1" ] && log "mode: --fail (failure-path evidence)"

# Acceptance: the SDK module tests pass.
./gradlew :sdk:test --rerun 2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" || fail ":sdk:test did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
ok ":sdk:test green (BUILD SUCCESSFUL, transcript in test.txt)"

# The probe runs against the classes the test run just built.
sdk_classes=sdk/build/classes/java/main
[ -d "$sdk_classes" ] || fail "missing $sdk_classes — run the gradle build first"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/T51Probe.java" <<'EOF'
import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.sched.SchedulerRegistry;
import com.astroreen.jhin.sdk.sched.TaskSpec;
import java.util.HashSet;
import java.util.Set;

/**
 * T51 QA probe: prints the X-Jhin-Client parse matrix with the actual parsed
 * values (mode {@code matrix}) and the garbage/unknown-key fallbacks plus the
 * SchedulerRegistry contract probes (mode {@code negative}). Exits non-zero
 * when any expectation fails. Mode {@code failprobe} asserts a deliberately
 * wrong expectation and always exits non-zero.
 */
public class T51Probe {

    private static int failures = 0;

    public static void main(String[] args) {
        String mode = args.length > 0 ? args[0] : "matrix";
        switch (mode) {
            case "matrix" -> matrix();
            case "negative" -> negative();
            case "failprobe" -> failprobe();
            default -> {
                System.out.println("unknown mode: " + mode);
                System.exit(2);
            }
        }
        if (failures > 0) {
            System.exit(1);
        }
    }

    // --- mode: matrix ---

    private static void matrix() {
        System.out.println("T51 parse matrix — ClientInfo.parse(X-Jhin-Client)");
        System.out.println("format: header -> api=<int> version='<str>' schema=<int> caps=<set>");
        System.out.println();
        line("<absent>", null, 1, "", 1, Set.of());
        line("\"\"", "", 1, "", 1, Set.of());
        line("\"api=2; version=1.4.0; schema=3; caps=sse,stream\"",
                "api=2; version=1.4.0; schema=3; caps=sse,stream", 2, "1.4.0", 3, Set.of("sse", "stream"));
        line("\"api=2\"            (partial)", "api=2", 2, "", 1, Set.of());
        line("\"api=abc; schema=xyz\" (garbage)", "api=abc; schema=xyz", 1, "", 1, Set.of());
        line("\"api=2; foo=bar\"     (unknown key)", "api=2; foo=bar", 2, "", 1, Set.of());
        line("\";;\"                (empty segments)", ";;", 1, "", 1, Set.of());
        line("\"api=2;\"            (trailing separator)", "api=2;", 2, "", 1, Set.of());
        line("\"api=2;;version=1.4.0;;schema=3;;caps=sse\"",
                "api=2;;version=1.4.0;;schema=3;;caps=sse", 2, "1.4.0", 3, Set.of("sse"));
        line("\"api=-5; schema=-5\"  (non-positive)", "api=-5; schema=-5", 1, "", 1, Set.of());
        line("\"caps=SSE , Stream\"  (case folding)", "caps=SSE , Stream", 1, "", 1, Set.of("sse", "stream"));
    }

    private static void line(String label, String header, int api, String version, int schema, Set<String> caps) {
        ClientInfo info = ClientInfo.parse(header);
        System.out.printf("header: %-38s -> api=%d version='%s' schema=%d caps=%s%n",
                label, info.api(), info.version(), info.schema(), info.caps());
        check(label + ": api", info.api() == api);
        check(label + ": version", info.version().equals(version));
        check(label + ": schema", info.schema() == schema);
        check(label + ": caps", info.caps().equals(caps));
    }

    // --- mode: negative ---

    private static void negative() {
        System.out.println("T51 negative probes — garbage falls back, nothing throws");
        System.out.println();

        ClientInfo garbageApi = ClientInfo.parse("api=x");
        System.out.printf("parse(\"api=x\")            -> api=%d schema=%d (fallback to defaults)%n",
                garbageApi.api(), garbageApi.schema());
        check("parse(\"api=x\").api() == 1", garbageApi.api() == 1);
        check("parse(\"api=x\").schema() == 1", garbageApi.schema() == 1);

        ClientInfo garbage = ClientInfo.parse("api=abc; schema=xyz");
        System.out.printf("parse(\"api=abc; schema=xyz\") -> api=%d schema=%d%n", garbage.api(), garbage.schema());
        check("garbage levels fall back to 1/1", garbage.api() == 1 && garbage.schema() == 1);

        ClientInfo negative = ClientInfo.parse("api=-5; schema=-5");
        System.out.printf("parse(\"api=-5; schema=-5\")  -> api=%d schema=%d%n", negative.api(), negative.schema());
        check("non-positive levels fall back to 1/1", negative.api() == 1 && negative.schema() == 1);

        ClientInfo unknown = ClientInfo.parse("api=2; foo=bar; vendor=acme");
        System.out.printf("parse(\"api=2; foo=bar; vendor=acme\") -> api=%d (unknown keys ignored)%n", unknown.api());
        check("unknown keys ignored, api kept", unknown.api() == 2);

        // SchedulerRegistry contract probes over a minimal implementation
        // (the executor itself is kernel-side, T52).
        Set<String> scheduled = new HashSet<>();
        SchedulerRegistry registry = new SchedulerRegistry() {
            @Override
            public TaskSpec schedule(TaskSpec spec) {
                scheduled.add(spec.name());
                return spec;
            }

            @Override
            public boolean cancel(String name) {
                return scheduled.remove(name);
            }

            @Override
            public Set<String> names() {
                return Set.copyOf(scheduled);
            }
        };
        TaskSpec spec = TaskSpec.oneShot("probe-task", 0, () -> {});
        TaskSpec handle = registry.schedule(spec);
        System.out.println("schedule(oneShot) -> handle returned: " + handle.name());
        check("schedule returns the spec as handle", handle == spec);
        check("names() reflects the schedule", registry.names().equals(Set.of("probe-task")));
        boolean missing = registry.cancel("missing");
        System.out.println("cancel(\"missing\") -> " + missing + " (idempotent no-op)");
        check("cancel(\"missing\") returns false", !missing);
        check("cancel(known) returns true", registry.cancel("probe-task"));
        check("cancel again is a no-op (false)", !registry.cancel("probe-task"));
        check("cancel(null) is a no-op, never throws", !registry.cancel(null));

        // TaskSpec validation rejects illegal specs at construction.
        boolean rejected = false;
        try {
            TaskSpec.oneShot("bad", -1, () -> {});
        } catch (IllegalArgumentException expected) {
            rejected = true;
        }
        System.out.println("TaskSpec.oneShot(name, -1, work) -> IllegalArgumentException: " + rejected);
        check("negative initialDelay rejected", rejected);
    }

    // --- mode: failprobe ---

    private static void failprobe() {
        int api = ClientInfo.parse("api=abc").api();
        System.out.printf("failprobe: parse(\"api=abc\").api() = %d, asserting 7 (wrong on purpose)%n", api);
        if (api != 7) {
            System.out.println("failprobe: intentional failure tripped (expected for --fail mode)");
            System.exit(1);
        }
        System.out.println("failprobe: unexpectedly passed");
    }

    private static void check(String what, boolean condition) {
        if (condition) {
            System.out.println("  ok: " + what);
        } else {
            failures++;
            System.out.println("  FAIL: " + what);
        }
    }
}
EOF
javac -cp "$sdk_classes" -d "$work" "$work/T51Probe.java" || fail "probe compilation failed"

java -cp "$sdk_classes:$work" T51Probe matrix > "$evidence/parse-matrix.txt" || fail "parse matrix probe failed (see $evidence/parse-matrix.txt)"
ok "parse-matrix.txt written (full X-Jhin-Client matrix, all expectations ok)"
grep -q "api=2 version='1.4.0' schema=3 caps=" "$evidence/parse-matrix.txt" \
        || fail "parse matrix does not show the full level-2 header parsed"
ok "full header parses all four fields (api=2, version=1.4.0, schema=3, caps=[sse, stream])"

java -cp "$sdk_classes:$work" T51Probe negative > "$evidence/negative.txt" || fail "negative probe failed (see $evidence/negative.txt)"
ok "negative.txt written (garbage fallbacks + scheduler contract probes)"
grep -q 'cancel("missing") -> false' "$evidence/negative.txt" || fail "cancel(\"missing\") did not return false"
grep -q 'api=1 schema=1' "$evidence/negative.txt" || fail "garbage api did not fall back to 1"
ok "garbage falls back to api=1/schema=1 and cancel(\"missing\") is a false no-op"

if [ "$fail_mode" = "1" ]; then
  # Negative probes must hold before the deliberate trip.
  grep -q 'api=1 schema=1' "$evidence/negative.txt" || fail "--fail probe: fallback evidence missing"
  ok "--fail probes passed: fallbacks and idempotent cancel hold"
  # Now deliberately trip the checker: a wrong expectation must fail.
  if java -cp "$sdk_classes:$work" T51Probe failprobe > "$evidence/failprobe.txt" 2>&1; then
    fail "--fail probe: wrong expectation unexpectedly passed (checker is broken)"
  fi
  ok "--fail probe: wrong expectation tripped as intended (see failprobe.txt)"
  fail "--fail mode: intentional failure-path exit"
fi

log "T51 QA green: SDK scheduler seam, client schema parsing and contract constants verified"
