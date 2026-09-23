ARG PLAYWRIGHT_BASE_DIGEST
FROM mcr.microsoft.com/playwright:v1.62.1-noble@${PLAYWRIGHT_BASE_DIGEST}

ARG ACTIONS_RUNNER_VERSION
ARG ACTIONS_RUNNER_SHA256

USER root
RUN set -eu; \
    printf '%s' "$ACTIONS_RUNNER_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; \
    printf '%s' "$ACTIONS_RUNNER_SHA256" | grep -Eq '^[a-f0-9]{64}$'; \
    ACTIONS_RUNNER_VERSION="$ACTIONS_RUNNER_VERSION" node -e ' \
      const fs = require("node:fs"); \
      const version = process.env.ACTIONS_RUNNER_VERSION; \
      const url = `https://github.com/actions/runner/releases/download/v${version}/actions-runner-linux-x64-${version}.tar.gz`; \
      fetch(url).then(async (response) => { \
        if (!response.ok) throw new Error("runner_archive_unavailable"); \
        fs.writeFileSync("/tmp/actions-runner.tar.gz", Buffer.from(await response.arrayBuffer()), { mode: 0o600 }); \
      }).catch(() => process.exit(1)); \
    '; \
    printf '%s  %s\n' "$ACTIONS_RUNNER_SHA256" /tmp/actions-runner.tar.gz | sha256sum -c -; \
    mkdir -p /opt/actions-runner; \
    tar -xzf /tmp/actions-runner.tar.gz -C /opt/actions-runner; \
    rm -f /tmp/actions-runner.tar.gz; \
    groupadd --gid 10001 billing-runner; \
    useradd --uid 10001 --gid 10001 --create-home --home-dir /home/billing-runner --shell /usr/sbin/nologin billing-runner; \
    chown -R 10001:10001 /opt/actions-runner /home/billing-runner

COPY --chmod=0555 entrypoint.sh /usr/local/bin/billing-validation-runner

ENV ACTIONS_RUNNER_HOME=/opt/actions-runner
WORKDIR /opt/actions-runner
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/billing-validation-runner"]
