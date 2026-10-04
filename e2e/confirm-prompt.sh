#!/usr/bin/env bash
# The repair and destroy confirmation prompt with every kind of standard input.
# Needs no fixture. Writes results/confirm-prompt.result.
source "$(dirname "$0")/lib.sh"
probe=$root/cli/.confirm-prompt-probe.ts
trap 'rm -f "$probe"' EXIT
cat >"$probe" <<'TS'
import { Cause, Effect, Exit } from "effect";
import { confirmInTerminal } from "./src/prompt.js";

const exit = await Effect.runPromiseExit(
  confirmInTerminal({
    step: "repair",
    render: "plan",
    question: "Apply? (y/N) ",
    accept: (answer) => answer.toLowerCase() === "y",
  }),
);
const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
console.log(
  failure === undefined
    ? `confirmed=${Exit.isSuccess(exit) && exit.value}`
    : `failed: ${failure instanceof Error ? failure.message : String(failure)}`,
);
TS

result=PASS
: >"$results/confirm-prompt.log"
check() {
  local label=$1 want=$2 input=$3 got
  got=$(cd "$root/cli" && timeout 20 sh -c "$input node_modules/.bin/tsx .confirm-prompt-probe.ts" 2>&1 |
    grep -oE "(confirmed=[a-z]+|failed: .*)" | tail -1)
  [[ $got == *"$want"* ]] || result=FAIL
  printf '%-22s want %-16s got %s\n' "$label" "$want" "${got:-nothing (hung)}" |
    tee -a "$results/confirm-prompt.log"
}
check "stdin closed" "Pass --yes" "</dev/null"
check "echo y" "confirmed=true" "echo y |"
check "printf y (no newline)" "confirmed=true" "printf y |"
check "echo n" "confirmed=false" "echo n |"
check "empty line" "confirmed=false" "echo |"
echo "result=$result" | tee "$results/confirm-prompt.result"
[[ $result == PASS ]]
