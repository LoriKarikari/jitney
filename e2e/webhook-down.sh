#!/usr/bin/env bash
# With no webhook reaching the fixture, a 30-second job and a 7-minute job still
# finish, and the Scheduler takes each Job's end state from GitHub (#147, #148).
# Passes when GitHub reports both jobs successful, the Scheduler reads `completed`
# and `success` for each, and the 7-minute job's runner is not reclaimed at the
# 5-minute assignment deadline. Writes results/webhook-down.{jsonl,result}.
source "$(dirname "$0")/lib.sh"
stamp=$(date +%s)

start_tail "$results/webhook-down.tail.jsonl"
route_off
trap 'restore_route; stop_tail' EXIT

short=$(dispatch long-job.yml "e2e-short-$stamp" -f seconds=30)
long=$(dispatch long-job.yml "e2e-long-$stamp" -f seconds=420)
echo "$(date -u +%FT%TZ) short run=$short long run=$long"
gh run watch "$short" -R "$fixture_repo" --interval 30 >/dev/null 2>&1
gh run watch "$long" -R "$fixture_repo" --interval 30 >/dev/null 2>&1

job_of() { gh run view "$1" -R "$fixture_repo" --json jobs --jq '.jobs[0] | "\(.databaseId) \(.conclusion)"'; }
read -r short_job short_conclusion <<<"$(job_of "$short")"
read -r long_job long_conclusion <<<"$(job_of "$long")"

# The Scheduler reads GitHub every 30 seconds once a runner exits.
sleep 120
events "$results/webhook-down.tail.jsonl" |
  jq -c --argjson a "$short_job" --argjson b "$long_job" 'select(.workflowJobId == $a or .workflowJobId == $b)' \
    >"$results/webhook-down.jsonl"

read_success() {
  jq -s --argjson id "$1" \
    'any(.[]; .event=="job_status_read" and .workflowJobId==$id and .state=="completed" and .conclusion=="success")' \
    "$results/webhook-down.jsonl"
}
reclaimed=$(jq -s --argjson id "$long_job" \
  'any(.[]; .event=="runner_attempt_expired" and .workflowJobId==$id and .stopReason=="assignment_deadline")' \
  "$results/webhook-down.jsonl")

result=PASS
[[ $short_conclusion == success && $long_conclusion == success ]] || result=FAIL
[[ $(read_success "$short_job") == true && $(read_success "$long_job") == true ]] || result=FAIL
[[ $reclaimed == false ]] || result=FAIL
{
  echo "result=$result"
  echo "short job $short_job: github=$short_conclusion scheduler_read_success=$(read_success "$short_job")"
  echo "long job $long_job: github=$long_conclusion scheduler_read_success=$(read_success "$long_job") reclaimed_at_assignment_deadline=$reclaimed"
} | tee "$results/webhook-down.result"
[[ $result == PASS ]]
