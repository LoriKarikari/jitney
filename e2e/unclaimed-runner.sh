#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"

start_tail "$results/unclaimed-runner.tail.jsonl"
trap stop_tail EXIT
dispatched_at=$(date +%s)
run=$(dispatch long-job.yml "e2e-unclaimed-$dispatched_at" -f seconds=600)
# Cancel before the new runner can claim the job.
while (( $(date +%s) < dispatched_at + 6 )); do sleep 0.2; done
gh api -X POST "repos/$fixture_repo/actions/runs/$run/cancel" >/dev/null
sleep 360

expired=$(events "$results/unclaimed-runner.tail.jsonl" |
  jq -s 'any(.[]; .event=="runner_attempt_expired" and .stopReason=="assignment_deadline")')
left=$(gh api "repos/$fixture_repo/actions/runners" --jq '.runners | length')

result=PASS
[[ $expired == true && $left == 0 ]] || result=FAIL
{
  echo "result=$result"
  echo "run $run: expired_at_assignment_deadline=$expired runners_left=$left"
} | tee "$results/unclaimed-runner.result"
[[ $result == PASS ]]
