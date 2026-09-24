#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

refuse() {
  printf 'runner_setup_refused:%s\n' "$1" >&2
  exit 1
}

runner_home=${ACTIONS_RUNNER_HOME:-/opt/actions-runner}
if [[ ! -d "$runner_home" || -L "$runner_home" || "$runner_home" != /* ]]; then
  refuse runner_home_invalid
fi
control_repository=${CONTROL_REPOSITORY:-}
control_event=${CONTROL_EVENT_NAME:-}
control_default_branch=${CONTROL_DEFAULT_BRANCH:-}
control_ref=${CONTROL_REF:-}
control_workflow_ref=${CONTROL_WORKFLOW_REF:-}
control_runner_group=${CONTROL_RUNNER_GROUP:-}
if [[ "$control_repository" != lawxcompany-stack/billing-validation-control ||
      "$control_event" != workflow_dispatch ||
      ! "$control_default_branch" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ ||
      "$control_default_branch" == *..* || "$control_default_branch" == *//* ||
      "$control_default_branch" == */ || "$control_default_branch" == *. ||
      "$control_default_branch" == *'@{'* ]]; then
  refuse runner_workflow_context_invalid
fi
IFS='/' read -r -a branch_parts <<< "$control_default_branch"
for branch_part in "${branch_parts[@]}"; do
  if [[ -z "$branch_part" || "$branch_part" == .* || "$branch_part" == *. ||
        "$branch_part" == *.lock ]]; then
    refuse runner_workflow_context_invalid
  fi
done
expected_ref="refs/heads/${control_default_branch}"
expected_workflow_ref="lawxcompany-stack/billing-validation-control/.github/workflows/validate-billing.yml@${expected_ref}"
if [[ "$control_ref" != "$expected_ref" || "$control_workflow_ref" != "$expected_workflow_ref" ||
      "$control_runner_group" != billing-validation-isolated ]]; then
  refuse runner_workflow_context_invalid
fi
if [[ ${GITHUB_REPOSITORY:-} != lawxcompany-stack/billing-validation-control ]]; then
  refuse runner_repository_invalid
fi
if [[ ! ${RUNNER_LABEL:-} =~ ^billing-validation-([0-9a-f]{32})$ ]]; then
  refuse runner_label_invalid
fi
if [[ -z ${RUNNER_REGISTRATION_TOKEN:-} || ${#RUNNER_REGISTRATION_TOKEN} -gt 512 ||
      "$RUNNER_REGISTRATION_TOKEN" == *$'\n'* || "$RUNNER_REGISTRATION_TOKEN" == *$'\r'* ]]; then
  refuse runner_registration_unavailable
fi

attempt_suffix=${BASH_REMATCH[1]}
runner_name="billing-validation-${attempt_suffix}"
runner_pid=''

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [[ -n "$runner_pid" ]] && kill -0 "$runner_pid" 2>/dev/null; then
    kill -TERM "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" 2>/dev/null || true
  fi
  unset RUNNER_REGISTRATION_TOKEN
  rm -f -- "$runner_home/.credentials" "$runner_home/.credentials_rsaparams"
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

if ! "$runner_home/config.sh" --unattended --ephemeral --disableupdate --no-default-labels \
    --url https://github.com/lawxcompany-stack/billing-validation-control \
    --token "$RUNNER_REGISTRATION_TOKEN" --name "$runner_name" --labels "$RUNNER_LABEL" \
    --runnergroup "$control_runner_group" \
    --work _work >/dev/null 2>&1; then
  unset RUNNER_REGISTRATION_TOKEN
  refuse runner_config_failed
fi
unset RUNNER_REGISTRATION_TOKEN

"$runner_home/run.sh" --once &
runner_pid=$!
set +e
wait "$runner_pid"
runner_status=$?
set -e
runner_pid=''
exit "$runner_status"
