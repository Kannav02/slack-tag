# Deploy Slack Tag

Install, update, or roll back Slack Tag on the VPS. The checks to run afterwards are the S6 checklist in `docs/plan.md`.

See [project and session mapping](project-mapping.md) for the current deployment, manual steps to connect another project, and the planned simpler onboarding flow.

Use the production Slack app here, never the dev app used by cloud agents. Socket Mode splits events between every connection that shares an app token.

## Install

Node.js 22.18 or later must be at `/usr/bin/node`, and Docker must have the Compose plugin. Project containers run under gVisor by default: install `runsc` from the [gVisor apt repository](https://gvisor.dev/docs/user_guide/install/) and run `runsc install && systemctl restart docker`. Where gVisor cannot run, put `SLACK_TAG_RUNTIME=runc` in `deploy/.env`. The checkout lives at `/opt/slack-tag`. The bridge writes `slack-tag.sqlite` beside `SLACK_TAG_CONFIG`, so the config lives in `/var/lib/slack-tag`.

1. Put the repo at `/opt/slack-tag` at the commit to run, and install both packages.

```bash
cd /opt/slack-tag
(cd plugin && npm ci --omit=dev) && (cd bridge && npm ci --omit=dev)
```

2. Create the directories and the env files. The `[ -e ]` guards keep a later install from wiping the tokens.

```bash
install -d -m 0755 /etc/slack-tag /var/lib/slack-tag
[ -e /etc/slack-tag/bridge.env ] || install -m 0600 -o root -g root deploy/bridge.env.example /etc/slack-tag/bridge.env
[ -e /etc/slack-tag/alpha.env ] || install -m 0600 -o root -g root deploy/project.env.example /etc/slack-tag/alpha.env
[ -e /etc/slack-tag/proxy.env ] || install -m 0600 -o root -g root deploy/proxy.env.example /etc/slack-tag/proxy.env
```

3. Fill the empty values. The Slack tokens go only in `bridge.env`, and the Go key only in `proxy.env`. Each project gets its own server password (for example `openssl rand -hex 32`): put it in that project's env file (`alpha.env`) as `OPENCODE_SERVER_PASSWORD`, and in `bridge.env` under the name its channel's `passwordEnv` gives (`ALPHA_SERVER_PASSWORD`). The bridge refuses to start if two channels share a password. Leave the mode at `0600`.

   Project containers never receive the Go key. Their OpenCode config sends model requests to the internal `key-proxy` service, which replaces the placeholder credential with the real key and forwards only to `https://opencode.ai/zen/go/v1`.
4. For each channel, run `deploy/prepare-project.sh <project folder>`, create its env file as in step 2, give it a service in `deploy/compose.yaml` (copy `beta`, with its own env file and network, and add that network to `key-proxy`), and add it to `/var/lib/slack-tag/config.json` in the shape of `config/example.json`, with `serverDir` set to `/project` and `opencodeUrl` set to the service's host port.
5. Write `deploy/.env` with the Compose variables, for example `ALPHA_PROJECT=/srv/slack-tag/projects/alpha` and `SLACK_TAG_RUNTIME=runsc`. It holds paths only, no secrets. Then start the containers. `restart: unless-stopped` brings them back after a reboot.

```bash
docker compose -f deploy/compose.yaml up -d --build
```

6. Install the units and start the firewall and the bridge. The firewall blocks project containers from the cloud metadata address and from the host; other internet access stays open.

```bash
install -m 0644 deploy/slack-tag.service deploy/slack-tag-firewall.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now slack-tag-firewall slack-tag
```

`journalctl -u slack-tag` names each channel as ready or unavailable. A channel is unavailable when its server is down or the safety plugin check fails. The bridge checks again on the next mention.

## Update

1. In `/opt/slack-tag`, check out the new commit and rerun the two `npm ci` commands.
   - Upgrading to the key proxy: create `proxy.env` as in install step 2, move `OPENCODE_API_KEY` from `opencode.env` into it, and delete the line from `opencode.env`. Compose overrides any key left in `opencode.env`, but do not keep a second copy.
   - Upgrading to per-project passwords: for each project, create its env file (`alpha.env`) with a new random `OPENCODE_SERVER_PASSWORD`, add the same value to `bridge.env` under the channel's `passwordEnv` name, and add `passwordEnv` to each channel in `config.json`. Then remove `OPENCODE_SERVER_PASSWORD` from `bridge.env` and delete `opencode.env`. Rolling back to an earlier commit needs both restored.
   - Upgrading to the separate agent user, gVisor and firewall: rerun `deploy/prepare-project.sh` on each project (agent shells run as uid 1001 in group 1000, so the project needs group write), install gVisor as in the install section, and install and enable `slack-tag-firewall` as in install step 6. Compose now gives each project network a fixed subnet (`172.30.N.0/24`); `docker compose down` before `up` so the networks are recreated.
2. Rebuild the containers and restart the bridge. Do not replace the env files.

```bash
docker compose -f deploy/compose.yaml up -d --build
install -m 0644 deploy/slack-tag.service /etc/systemd/system/slack-tag.service
systemctl daemon-reload
systemctl restart slack-tag
```

## Roll back

Check out the previous commit in `/opt/slack-tag` and run the update steps. To stop everything, run `systemctl disable --now slack-tag` and `docker compose -f deploy/compose.yaml down`. The data volumes stay, so sessions survive.
