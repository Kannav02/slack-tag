FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @opencode/cli@2.0.15

# OpenCode resolves "../plugin" from the config file's directory, so this mirrors the repo's deploy/ and plugin/.
WORKDIR /opt/slack-tag
COPY plugin/package.json plugin/package-lock.json plugin/
RUN cd plugin && npm ci --omit=dev
COPY plugin plugin
COPY deploy/opencode.global.jsonc opencode/opencode.jsonc
COPY proxy proxy

COPY deploy/start-server.sh /usr/local/bin/start-server
COPY deploy/agent-shell.sh /usr/local/bin/agent-shell

# Agent shells run as agent (uid 1001) in the node group, so they can edit the project but not read the server.
RUN mkdir -p /data /project && chown node:node /data /project && chmod 700 /data \
  && useradd --uid 1001 --gid node --no-create-home --shell /bin/bash agent \
  && git config --system safe.directory '*'

ENV HOME=/data \
  XDG_CONFIG_HOME=/opt/slack-tag \
  XDG_DATA_HOME=/data/share \
  XDG_STATE_HOME=/data/state \
  XDG_CACHE_HOME=/data/cache

WORKDIR /project
EXPOSE 4096
CMD ["start-server"]
