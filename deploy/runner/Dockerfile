# Self-hosted GitHub Actions runner for the agentbus bus-repo workflows (join /
# digest). Private repos only. Based on GitHub's official runner image, plus the few tools our
# jobs call directly: git (agentbus itself), gh (digest posting), jq, curl.
FROM ghcr.io/actions/actions-runner:latest

USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git jq openssh-client tar xz-utils; \
    mkdir -p -m 755 /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p /opt/hostedtoolcache; \
    chown runner:runner /opt/hostedtoolcache

COPY --chmod=755 entrypoint.sh /entrypoint.sh

USER runner
WORKDIR /home/runner
ENTRYPOINT ["/entrypoint.sh"]
