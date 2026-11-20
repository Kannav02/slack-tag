# Deploy Slack Tag

Install, update, or roll back Slack Tag on the VPS. The checks to run afterwards are the S6 checklist in `docs/plan.md`.

See [project and session mapping](project-mapping.md) for the current deployment, manual steps to connect another project, and the planned simpler onboarding flow.

Use the production Slack app here, never the dev app used by cloud agents. Socket Mode splits events between every connection that shares an app token. The bot needs the `files:write` scope for files the agent posts with `slack_attach`.

## Install

Node.js 22.18 or later must be at `/usr/bin/node`, and Docker must have the Compose plugin. Project containers run under gVisor by default: install `runsc` from the [gVisor apt repository](https://gvisor.dev/docs/user_guide/install/) and run `runsc install && systemctl restart docker`. Where gVisor cannot run, put `SLACK_TAG_RUNTIME=runc` in `deploy/.env`. The checkout lives at `/opt/slack-tag`. The bridge writes `slack-tag.sqlite` beside `SLACK_TAG_CONFIG`, so the config lives in `/var/lib/slack-tag`.

1. Put the repo at `/opt/slack-tag` at the commit to run, and install both packages.

```bash
cd /opt/slack-tag
(cd plugin && npm ci --omit=dev) && (cd bridge && npm ci --omit=dev)
```

2. Create the bridge's own system user, the directories and the env files. The `[ -e ]` guards keep a later install from wiping the tokens.

```bash
id slack-tag >/dev/null 2>&1 || useradd --system --home-dir /var/lib/slack-tag --shell /usr/sbin/nologin slack-tag
install -d -m 0755 /etc/slack-tag
install -d -m 0700 -o slack-tag -g slack-tag /var/lib/slack-tag
install -d -m 2750 -o slack-tag -g 1000 /var/lib/slack-tag/inbox
[ -e /etc/slack-tag/bridge.env ] || install -m 0600 -o root -g root deploy/bridge.env.example /etc/slack-tag/bridge.env
[ -e /etc/slack-tag/alpha.env ] || install -m 0600 -o root -g root deploy/project.env.example /etc/slack-tag/alpha.env
[ -e /etc/slack-tag/proxy.env ] || install -m 0600 -o root -g root deploy/proxy.env.example /etc/slack-tag/proxy.env
```

3. Fill the empty values. The Slack tokens go only in `bridge.env`, and the Go key only in `proxy.env`. Each project gets its own server password (for example `openssl rand -hex 32`): put it in that project's env file (`alpha.env`) as `OPENCODE_SERVER_PASSWORD`, and in `bridge.env` under the name its channel's `passwordEnv` gives (`ALPHA_SERVER_PASSWORD`). The bridge refuses to start if two channels share a password. Leave the env files `root`-owned with mode `0600`: systemd reads `bridge.env` before switching to the `slack-tag` user, so the bridge itself cannot reread it. Keep `config.json` owned by `slack-tag` with mode `0600`.

   Project containers never receive the Go key. Their OpenCode config sends model requests to the internal `key-proxy` service, which replaces the placeholder credential with the real key and forwards only to `https://opencode.ai/zen/go/v1`.
4. To register projects from Slack, add the `onboarding` section from `config/example.json` (with `"start": "systemd"`) and see [project mapping](project-mapping.md). The bridge's `slack-tag` user has no Docker access, so it asks systemd to start each registered project as root through `deploy/start-project.sh`, which checks the project's env file before running `docker compose`. Install that path once (polkit 0.106 or later, for JavaScript rules; Ubuntu 24.04 and Debian 12 qualify):

   ```bash
   install -m 0644 deploy/slack-tag-project@.service /etc/systemd/system/
   install -m 0644 deploy/50-slack-tag.rules /etc/polkit-1/rules.d/
   printf 'SLACK_TAG_PROJECTS_ROOT=/srv/slack-tag/projects\nSLACK_TAG_RUNTIME=runsc\n' > /etc/slack-tag/registration.env
   chmod 0600 /etc/slack-tag/registration.env
   systemctl daemon-reload
   ```

   `SLACK_TAG_PROJECTS_ROOT` must match `onboarding.projectsRoot`. Keep it outside `/home`: the bridge unit hides `/home` (`ProtectHome`) and makes every other folder read-only, so the bridge only lists the folder names. The bridge does not write to projects; `deploy/start-project.sh` prepares each folder with `deploy/prepare-project.sh` as uid 1000 (the container user, `setpriv` from util-linux), never as root, and closes it to other users (`chmod o-rwx`). The folder must therefore be owned by uid 1000 and listable by `slack-tag`. To move existing projects (Git remotes and credentials stay valid, because they live in `.git/config` and your home folder):

   ```bash
   install -d -m 0755 -o 1000 -g 1000 /srv/slack-tag/projects
   mv /home/devuser/projects/<project> /srv/slack-tag/projects/
   chmod o-rwx /srv/slack-tag/projects/*
   ln -s /srv/slack-tag/projects /home/devuser/projects   # optional: keep the old path for your shell
   ```

   Then update that channel's `projectDir` in `config.json` (or `deploy/.env` for a hand-made channel) and recreate its container. Clone new projects into `/srv/slack-tag/projects` as uid 1000 before you register them. `/opt/slack-tag` must stay root-owned and not writable by `slack-tag`, because root runs `deploy/start-project.sh` from it. Check the rule with `sudo -u slack-tag systemctl start --no-ask-password slack-tag-project@nonexistent.service`: it should fail as a job (`journalctl -u slack-tag-project@nonexistent` shows "no env file"), not with "Access denied". Any other unit, or `stop`, must still say "Access denied".

   For each channel connected by hand, run `deploy/prepare-project.sh <project folder>`, create its upload inbox `/var/lib/slack-tag/inbox/<channel name>` owned by the bridge's user (`install -d -m 0755 -o <bridge user> …`) before starting its container, create its env file as in step 2, give it a service in `deploy/compose.yaml` (copy `beta`, with its own env file, network and `/inbox` mount, and add that network to `key-proxy`), and add it to `/var/lib/slack-tag/config.json` in the shape of `config/example.json`, with `serverDir` set to `/project` and `opencodeUrl` set to the service's host port.
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

The unit runs the bridge as `slack-tag` (not uid 1000, the container user). Only `/var/lib/slack-tag` is writable; the rest of the system is read-only and `/home` is hidden, so the bridge never touches project folders. The attachment inbox is the one shared folder: owner `slack-tag`, group 1000, mode `2750`, so the containers' user can read uploads but not change them, and new folders inherit group 1000. Everything else in `/var/lib/slack-tag` is private to `slack-tag`.

`journalctl -u slack-tag` names each channel as ready or unavailable. A channel is unavailable when its server is down or the safety plugin check fails. The bridge checks again on the next mention.

## Update

1. In `/opt/slack-tag`, check out the new commit and rerun the two `npm ci` commands.
   - Upgrading to the key proxy: create `proxy.env` as in install step 2, move `OPENCODE_API_KEY` from `opencode.env` into it, and delete the line from `opencode.env`. Compose overrides any key left in `opencode.env`, but do not keep a second copy.
   - Upgrading to per-project passwords: for each project, create its env file (`alpha.env`) with a new random `OPENCODE_SERVER_PASSWORD`, add the same value to `bridge.env` under the channel's `passwordEnv` name, and add `passwordEnv` to each channel in `config.json`. Then remove `OPENCODE_SERVER_PASSWORD` from `bridge.env` and delete `opencode.env`. Rolling back to an earlier commit needs both restored.
   - Upgrading to the separate upload inbox: create `/var/lib/slack-tag/inbox/<channel name>` for each channel as in install step 4, and set `ALPHA_INBOX` in the Compose environment if it differs from `/var/lib/slack-tag/inbox/alpha`. Channel names may only use letters, digits, `-` and `_`. The bridge now refuses a `projectDir` that is `/`, holds, or sits inside `/var/lib/slack-tag`. Old uploads in `<project>/.slack-tag/` are no longer used; delete them once no thread needs them.
   - Upgrading to the separate agent user, gVisor and firewall: rerun `deploy/prepare-project.sh` on each project (agent shells run as uid 1001 in group 1000, so the project needs group write), install gVisor as in the install section, and install and enable `slack-tag-firewall` as in install step 6. Compose now gives each project network a fixed subnet (`172.30.N.0/24`); `docker compose down` before `up` so the networks are recreated.
   - Upgrading to `slack_attach` (agent file uploads): add the `files:write` bot scope to the Slack app and reinstall it, which changes the live app and needs the owner's go-ahead. The tool lives in the plugin baked into the image, so rebuild the containers in the same update as the bridge. Without the scope, each upload fails with a note in the thread.
   - Upgrading to `/fix`: the command lives in the same plugin, so rebuild the containers with the bridge; an older image answers `/fix` with "Command not found: fix". Its `fix-commands.log` upload also needs `files:write`.
   - Upgrading to the `.git` mount lock (#60): Compose now bind-mounts the whole `.git` as its own read-write mount point (`/project/.git`), with `.git/config`, `.git/hooks` and `.git/commondir` nested under it read-only, so the agent can no longer rename or delete `.git` to move those read-only mounts aside. No new files or env are needed — `deploy/prepare-project.sh` already creates `.git` — but the container must be **recreated**, not just restarted, to pick up the mount: `docker compose down` then `up -d` (step 2) replaces it. Confirm afterwards with `mountpoint /project/.git` inside the container (or `docker inspect` showing the `/project/.git` bind). Rolling back to an earlier commit and recreating removes the mount.
   - Upgrading to the dedicated bridge user: deploy together with the separate attachment inbox (SEC-1), because this unit cannot reach project folders. Stop the bridge, then create the user and fix ownership. If an override sets `User=` (the live VPS uses `devuser`), remove it.

     ```bash
     systemctl stop slack-tag
     id slack-tag >/dev/null 2>&1 || useradd --system --home-dir /var/lib/slack-tag --shell /usr/sbin/nologin slack-tag
     chown -R slack-tag:slack-tag /var/lib/slack-tag && chmod 0700 /var/lib/slack-tag
     find /var/lib/slack-tag -maxdepth 1 -type f -exec chmod 0600 {} +
     install -d -m 2750 -o slack-tag -g 1000 /var/lib/slack-tag/inbox
     chown root:root /etc/slack-tag/*.env && chmod 0600 /etc/slack-tag/*.env
     rm -f /etc/systemd/system/slack-tag.service.d/10-service-user.conf
     ```

     Then continue with step 2. To roll back, reinstall the previous unit (and the override, if any) and `chown -R` `/var/lib/slack-tag` back to the old user.
   - Upgrading to app screenshots ([#43](https://github.com/Kannav02/slack-tag/issues/43)): the image adds Playwright 1.56.1 and Chromium headless shell 141.0.7390.37 with its Debian libraries and fonts, about 0.65 GB (estimated). Step 2 rebuilds it; the build also downloads the browser from `cdn.playwright.dev`. Then run `systemctl start slack-tag-project@<name>.service` for each registered project so its container is recreated on the new image. Compose and env files do not change.
   - Upgrading to document uploads (DOC-1): the image adds `pandoc` and `poppler-utils` (`pdftotext`), about 0.2 GB (estimated from Ubuntu 24.04's installed sizes, almost all of it pandoc 3.1.3 at 190 MB; bookworm ships pandoc 2.17, so the real figure differs). Rebuild the containers in the same update as the bridge: the bridge now tells the agent to read documents with these tools, and an older image has neither, while its plugin reports the same policy version 3 and asks before every conversion. Step 2 rebuilds the image; then run `systemctl start slack-tag-project@<name>.service` for each registered project. Compose and env files do not change.
2. Rebuild the containers and restart the bridge. Do not replace the env files.

```bash
docker compose -f deploy/compose.yaml up -d --build
install -m 0644 deploy/slack-tag.service /etc/systemd/system/slack-tag.service
systemctl daemon-reload
systemctl restart slack-tag
```

## Roll back

Check out the previous commit in `/opt/slack-tag` and run the update steps. To stop everything, run `systemctl disable --now slack-tag` and `docker compose -f deploy/compose.yaml down`. The data volumes stay, so sessions survive.

## Per-thread worktrees (opt-in)

Gives each new Slack thread its own Git worktree on a `jeff/<slug>` branch so threads run concurrently (see [project mapping](project-mapping.md)). Enable it per project; the behaviour and the isolation hold only with all three steps.

1. Mount a writable volume for worktrees on the project's OpenCode service at `/worktrees` (e.g. add a `worktrees-data:/worktrees` volume to its `compose.yaml`/`project.yaml` service and declare it; it must not be `read_only`). Add `CHOWN` and `FOWNER` to that service's startup capabilities alongside `SETUID` and `SETGID`: `start-server` changes the volume owner and mode before dropping to the server user with only SETUID/SETGID. It makes the volume group-1000-writable with setgid so agent shells can edit worktree files. Worktrees live outside `/project`; the project must already have a Git commit.
2. Set `OPENCODE_CONFIG_PROJECT_DISABLE=1` and `SLACK_TAG_WORKTREE_DIR=/worktrees` in that server's environment. `OPENCODE_CONFIG_PROJECT_DISABLE` stops OpenCode loading agent-controlled config or plugins from a worktree checkout (required for safety; it also turns off AGENTS.md auto-loading on that server). The server's git hardening (`core.fsmonitor=false`, `core.hooksPath=/dev/null`) is applied by `start-server` and needs no configuration.
3. Add `"worktrees": true` to the channel in `config.json` and restart the bridge. If the server lacks step 2 the plugin refuses and threads fall back to `/project`, so apply 1–2 before 3.

Production research uses `/etc/slack-tag/alpha-worktrees.yaml`; include it after `deploy/git-proxy-alpha.yaml` on every fixed-project Compose update. Dogfooding has no initial commit and remains on the shared checkout. The registered launcher hardcodes `project.yaml`, so `COMPOSE_FILE` in its systemd environment does not add an override.

Project preparation runs as uid 1000 and can fail on files created by agent uid 1001. Stop the project before repairing ownership; only normalize uid-1001 regular files/directories within the project, without following symlinks, then rerun preparation as uid 1000. Do not run the preparation script as root against agent-controlled paths.

## Private GitHub repositories (opt-in)

For the request flow, URL rewriting and credential boundary, see [Git proxy](git-proxy.md).

Git in the agent has no personal SSH keys or SSH client. Add a repository-scoped Git smart-HTTP proxy; do not mount your SSH directory or give the agent a token. Requires Docker Compose 2.24.4+ (`!override`). Deploy this separately from merging the code.

1. Reuse the existing `gh` login for **Kannav02** on the host (`devuser` on Hetzner). `deploy/with-git-credential.sh` reads it at startup without printing it; no new token or SSH-key mount is needed. Store `deploy/git-proxy.env.example` as `/etc/slack-tag/git/<project>.env`, root-owned mode `0600`, inside a root-owned mode `0700` directory. Fill `GITHUB_REPOSITORY=owner/repository` (without `.git`); this file contains no token.
2. Before `GIT_ALLOW_PUSH=1`, enable GitHub rules preventing force updates and deletions on **all writable branches and tags**, with **no bypass for the token identity**. The shell policy blocks force flags, but an agent could construct Git protocol requests directly. The proxy cannot prove ancestry; upstream rules are the enforcement boundary. Leave writes disabled until these rules are verified.
3. For the fixed `alpha` project (GEM), rebuild the image and include the override on every subsequent Compose command:
   ```sh
   sudo env GIT_CREDENTIAL_USER=devuser GIT_PROXY_ENV_FILE=/etc/slack-tag/git/alpha.env \
     sh deploy/with-git-credential.sh docker compose --env-file /etc/slack-tag/compose.env -f deploy/compose.yaml -f deploy/git-proxy-alpha.yaml up -d --build
   ```
   The proxy joins only alpha's network at `172.30.1.254`, with no published port. Check that `.254` is free before applying. Beta is unchanged; another fixed project needs its own sidecar, network address and mapping file.
4. For a registered project, use `systemctl edit slack-tag-project@<name>.service` and add:
   ```ini
   [Service]
   Environment=GIT_PROXY_ENV_FILE=/etc/slack-tag/git/<name>.env
   Environment=GIT_CREDENTIAL_USER=devuser
   ```
   Restart that instance after rebuilding the image. **Do not put this setting in shared `registration.env`**: that would grant every registered project the same repository access. The launcher accepts this setting only from the trusted service environment; bridge-written project env files cannot enable it. The registered override uses only its own `172.31.<net>.254` address.
5. Verify `git ls-remote origin`, `git fetch origin`, `git pull --ff-only origin main`, then a normal push to a disposable branch. Verify rewriting/deleting that branch is rejected by GitHub rules; delete the test branch administratively afterward. Do not force-push a production branch to test protections.
6. Optional pull requests: with pushes enabled, set `GIT_ALLOW_PULL_REQUESTS=1` so the agent's `open_pull_request` tool can open or find pull requests from `jeff/*` branches into the default branch; the host account (Kannav02) authors them. Rebuild the image, then recreate the project as in step 3 or 4, so the proxy gets the setting and the agent container gets `GIT_PROXY_URL`. Verify with a disposable `jeff/` branch, then close its pull request and delete the branch.

The overrides rewrite GitHub HTTPS URLs and personal `github.com-kannav02` SSH aliases to the proxy without changing the mounted `.git/config`. The host login may access multiple repositories, but only the proxy receives its token. Its exact repository and smart-HTTP endpoint allowlist prevents using the credential for another repository; redirects and upstream error details are not returned. Submodules, LFS, other SSH aliases and repositories need separate configuration and are not supported by this proxy. `git push origin <branch>` works; `git push -u` may fail to save tracking metadata because `.git/config` remains read-only. Removing the override/per-instance setting and recreating the agent disables proxy routing; remove the unused sidecar as well. No production credentials or deployment are included in this change.

Verified on Hetzner with the existing `devuser` Kannav02 login: a temporary loopback proxy completed `ls-remote` and a shallow fetch of `maraja/gem-research-suite`; another repository and disabled writes returned 403. No production services changed. Automated proxy coverage is deferred to [issue #36](https://github.com/Kannav02/slack-tag/issues/36).
