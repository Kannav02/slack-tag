# Deploy Slack Tag

Install, update, or roll back Slack Tag on the VPS. The checks to run afterwards are the S6 checklist in `docs/plan.md`.

Use the production Slack app here, never the dev app used by cloud agents. Socket Mode splits events between every connection that shares an app token.

## Install

Node.js 22.18 or later must be at `/usr/bin/node`, and Docker must have the Compose plugin. Install gVisor (`runsc`) if the VPS supports it. The checkout lives at `/opt/slack-tag`. The bridge writes `slack-tag.sqlite` beside `SLACK_TAG_CONFIG`, so the config lives in `/var/lib/slack-tag`.

1. Put the repo at `/opt/slack-tag` at the commit to run, and install both packages.

```bash
cd /opt/slack-tag
(cd plugin && npm ci --omit=dev) && (cd bridge && npm ci --omit=dev)
```

2. Create the directories and the env files. The `[ -e ]` guards keep a later install from wiping the tokens.

```bash
install -d -m 0755 /etc/slack-tag /var/lib/slack-tag
[ -e /etc/slack-tag/bridge.env ] || install -m 0600 -o root -g root deploy/bridge.env.example /etc/slack-tag/bridge.env
[ -e /etc/slack-tag/opencode.env ] || install -m 0600 -o root -g root deploy/opencode.env.example /etc/slack-tag/opencode.env
```

3. Fill the empty values. The Slack tokens go only in `bridge.env`, and the Go key only in `opencode.env`. Both files get the same `OPENCODE_SERVER_PASSWORD`. Leave the mode at `0600`.
4. For each channel, run `deploy/prepare-project.sh <project folder>`, give it a service in `deploy/compose.yaml` (copy `beta`), and add it to `/var/lib/slack-tag/config.json` in the shape of `config/example.json`, with `serverDir` set to `/project` and `opencodeUrl` set to the service's host port.
5. Write `deploy/.env` with the Compose variables, for example `ALPHA_PROJECT=/srv/slack-tag/projects/alpha` and `SLACK_TAG_RUNTIME=runsc`. It holds paths only, no secrets. Then start the containers. `restart: unless-stopped` brings them back after a reboot.

```bash
docker compose -f deploy/compose.yaml up -d --build
```

6. Install the unit and start the bridge.

```bash
install -m 0644 deploy/slack-tag.service /etc/systemd/system/slack-tag.service
systemctl daemon-reload
systemctl enable --now slack-tag
```

`journalctl -u slack-tag` names each channel as ready or unavailable. A channel is unavailable when its server is down or the safety plugin check fails. The bridge checks again on the next mention.

## Update

1. In `/opt/slack-tag`, check out the new commit and rerun the two `npm ci` commands.
2. Rebuild the containers and restart the bridge. Do not replace the env files.

```bash
docker compose -f deploy/compose.yaml up -d --build
install -m 0644 deploy/slack-tag.service /etc/systemd/system/slack-tag.service
systemctl daemon-reload
systemctl restart slack-tag
```

## Roll back

Check out the previous commit in `/opt/slack-tag` and run the update steps. To stop everything, run `systemctl disable --now slack-tag` and `docker compose -f deploy/compose.yaml down`. The data volumes stay, so sessions survive.
