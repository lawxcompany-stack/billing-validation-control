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
control_repository_id=${CONTROL_REPOSITORY_ID:-}
control_event=${CONTROL_EVENT_NAME:-}
control_default_branch=${CONTROL_DEFAULT_BRANCH:-}
control_ref=${CONTROL_REF:-}
control_workflow_path=${CONTROL_WORKFLOW_PATH:-}
control_workflow_ref=${CONTROL_WORKFLOW_REF:-}
control_run_id=${CONTROL_RUN_ID:-}
control_run_attempt=${CONTROL_RUN_ATTEMPT:-}
control_workflow_sha=${CONTROL_WORKFLOW_SHA:-}
control_candidate_sha=${CONTROL_CANDIDATE_SHA:-}
control_activation_commitment=${CONTROL_ACTIVATION_COMMITMENT:-}
control_runner_label=${CONTROL_RUNNER_LABEL:-}
control_runner_group=${CONTROL_RUNNER_GROUP:-}
if [[ "$control_repository" != lawxcompany-stack/billing-validation-control ||
      ! "$control_repository_id" =~ ^[1-9][0-9]{0,19}$ ||
      "$control_event" != workflow_dispatch ||
      "$control_default_branch" != main ||
      "$control_ref" != refs/heads/main ||
      "$control_workflow_path" != .github/workflows/validate-billing.yml ||
      "$control_workflow_ref" != lawxcompany-stack/billing-validation-control/.github/workflows/validate-billing.yml@refs/heads/main ||
      ! "$control_run_id" =~ ^[1-9][0-9]{0,15}$ ||
      ! "$control_run_attempt" =~ ^[1-9][0-9]{0,7}$ ||
      ! "$control_workflow_sha" =~ ^[a-f0-9]{40}$ ||
      ! "$control_candidate_sha" =~ ^[a-f0-9]{40}$ ||
      ! "$control_activation_commitment" =~ ^[a-f0-9]{64}$ ||
      ! "$control_runner_label" =~ ^billing-validation-[a-f0-9]{32}$ ||
      "$control_runner_group" != billing-validation-isolated ]]; then
  refuse runner_workflow_context_invalid
fi
if [[ ! "$control_runner_label" =~ ^billing-validation-([0-9a-f]{32})$ ||
      "$control_runner_label" != "${RUNNER_LABEL:-}" ]]; then
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
