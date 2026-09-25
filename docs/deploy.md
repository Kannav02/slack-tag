# Deploy Slack Tag

Install the bridge on the VPS, update it, or roll it back. This page does not start the service for you. The VPS checklist at the end is marked `needs owner` until someone runs it on the machine.

The production Slack app is separate from the dev app used by earlier slices. Socket Mode delivers each event to one connection. Two bridges that share an app token split those events.

`deploy/compose.yaml` is slice S5. This page does not add it. When that file exists, set `restart: unless-stopped` on each channel service so the containers return after a reboot.

## Install

Node.js 22.18 or later must be installed at `/usr/bin/node`. The checkout lives at `/opt/slack-tag`. systemd reads `/etc/slack-tag/bridge.env` as root and passes those variables to the process. The bridge writes `slack-tag.sqlite` beside `SLACK_TAG_CONFIG`, so the config file lives under `/var/lib/slack-tag`.

1. Copy the repo to `/opt/slack-tag` at the commit you want to run.
2. Create the directories.

```bash
install -d -m 0755 /etc/slack-tag /var/lib/slack-tag /opt/slack-tag
```

3. Create the env files only when they are missing. A later install must not replace them, or it would wipe the tokens.

```bash
install -m 0600 -o root -g root deploy/bridge.env.example /etc/slack-tag/bridge.env
install -m 0600 -o root -g root deploy/opencode.env.example /etc/slack-tag/opencode.env
```

If a file already exists, skip that `install` line.

4. Fill the empty values in `/etc/slack-tag/bridge.env` and `/etc/slack-tag/opencode.env`. Leave the mode at `0600` and the owner at root. Put the Go key only in `opencode.env`. Put the Slack tokens only in `bridge.env`.
5. Write `/var/lib/slack-tag/config.json` in the shape from `docs/plan.md`. `projectDir` is the host path. `serverDir` is `/project` once S5 runs OpenCode in a container.
6. Install the unit and start the bridge.

```bash
install -m 0644 deploy/slack-tag.service /etc/systemd/system/slack-tag.service
systemctl daemon-reload
systemctl enable --now slack-tag
```

Run the same directory and unit commands again. They leave the existing env files and the same unit in place.

`systemctl status slack-tag` should show the service active. The bridge log names each channel as ready or unavailable. A channel is unavailable when its OpenCode server is down or the safety plugin check fails.

## Update

1. In `/opt/slack-tag`, check out the new commit.
2. Install the unit again and restart the bridge. Do not replace the env files.

```bash
install -m 0644 deploy/slack-tag.service /etc/systemd/system/slack-tag.service
systemctl daemon-reload
systemctl restart slack-tag
```

3. When `deploy/compose.yaml` exists, run `docker compose -f deploy/compose.yaml up -d` from `/opt/slack-tag`.

## Roll back

1. In `/opt/slack-tag`, check out the previous commit.
2. Run the update commands again.
3. To stop the bridge, run `systemctl disable --now slack-tag`.

## VPS checklist

Run this on the VPS with the production Slack app and real project folders. Use a disposable project for the destructive steps. Every step below is `needs owner`. This environment has no `VPS_SSH_HOST`.

- [ ] 1. `needs owner`. Run `systemctl status slack-tag` and `docker compose ps`. Pass when the bridge is active, every channel container is running, and the bridge log reports the plugin check passed for every channel.
- [ ] 2. `needs owner`. Rerun S2 steps 1 to 5. Pass when every step passes.
- [ ] 3. `needs owner`. Rerun S3 steps 1 to 4, 8, and 9. Pass when every step passes.
- [ ] 4. `needs owner`. Rerun S4 steps 1 and 4. Pass when both pass.
- [ ] 5. `needs owner`. Rerun S5 steps 1 and 3 to 7 under `runsc`, or record why the VPS cannot run gVisor. Pass when every step passes.
- [ ] 6. `needs owner`. Reboot the VPS. Pass when the bridge and containers come back without manual steps, and a reply in an earlier thread continues its conversation.
- [ ] 7. `needs owner`. Trigger an approval, restart only the bridge, then approve. Pass when the command runs once.
- [ ] 8. `needs owner`. Run `ls -l` on the env files and `ps -eo args | grep -E 'xox|xapp'`. Pass when the env files are `-rw-------` owned by root and no process argument contains a token.
