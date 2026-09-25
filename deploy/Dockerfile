FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @opencode/cli@2.0.15

WORKDIR /opt/slack-tag
COPY plugin/package.json plugin/package-lock.json plugin/
RUN cd plugin && npm install --omit=dev
COPY plugin plugin
COPY deploy/opencode.container.jsonc /opt/slack-tag/xdg/opencode/opencode.jsonc

RUN mkdir -p /data /project /tmp \
  && chown -R node:node /data /project /tmp

ENV HOME=/data \
  XDG_CONFIG_HOME=/opt/slack-tag/xdg \
  XDG_DATA_HOME=/data/share \
  XDG_STATE_HOME=/data/state \
  XDG_CACHE_HOME=/data/cache

USER node
WORKDIR /project
EXPOSE 4096
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
