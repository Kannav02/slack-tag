# Hosting

Proposal for the owner's review, 2026-10-20. Nothing here is built. The items are listed in [the backlog](backlog.md) as HOST-1, HOST-2, HOST-3, LIFE-1, SEC-8 and MODEL-1, and wait for approval. The audience is in [positioning](positioning.md): one technical host runs Slack Tag for people who just chat.

## What a host needs

- A Linux server (Ubuntu 24.04 or Debian 12) with Docker and its Compose plugin, and gVisor where the server allows it.
- A Slack app in their workspace, with a bot token and a Socket Mode app token.
- A model plan. OpenCode Go costs $10 a month, is still in beta, and limits spending per model over 5 hours, a week and a month (see [findings](findings.md)).
- Memory for the projects. Each project container may use up to 2 GB and 512 processes, and every registered project also runs a key proxy limited to 128 MB. Neither has a CPU limit (SEC-8). Until idle projects stop (LIFE-1), plan about 2 GB per project. The project image includes Chromium for screenshots, estimated at 0.65 GB of disk.

## What it takes today

[Deployment](deploy.md) has six numbered install steps, and several of them are a page of commands:

1. Create the Slack app by hand. The repository lists no scopes in one place. From the code, the bridge's Slack calls need `chat:write`, `reactions:write`, `files:read`, `files:write`, `channels:history` and `groups:history`, Socket Mode with a `connections:write` app token, and interactivity for buttons and the folder menu. `files:write` and `reactions:write` were each added later, and each needed the live app reinstalled.
2. Install Node.js, Docker and gVisor, then restart Docker. On the VPS, gVisor's apt repository failed its signature check, so it was installed from the release archive instead.
3. Check out the code to `/opt/slack-tag` and install both packages.
4. Create the `slack-tag` user, its folders and three env files, and fill in the Slack tokens, the model key and the passwords.
5. Install the registration unit, the polkit rule and `registration.env`, and move projects under `/srv/slack-tag/projects`, owned by uid 1000.
6. Build and start the containers, then install and start the bridge and firewall units.

Pushing to GitHub adds six more steps per project ([Git proxy](deploy.md#private-github-repositories-opt-in)), and per-thread worktrees add three. Updates are manual too: the update section has nine version-specific notes so far. An experienced Linux administrator can do all of this in a few hours; most hosts would stop at step 2.

## Proposed items

### HOST-1: Slack app manifest

One file, `deploy/slack-app-manifest.yaml`, that the host pastes into "Create an app from a manifest" on api.slack.com. It holds the bot user, Socket Mode, interactivity, message events and every scope the bridge needs. The host then creates the app token and installs the app. Scopes become reviewable in the repository, and a new feature's scope change is a one-line diff. A test keeps the manifest in step with the Slack methods the bridge calls. Small.

Decide first: the bot's default name, which is tied to the product name.

### HOST-2: One-command install

`sudo scripts/install.sh` on a fresh Ubuntu 24.04 or Debian 12 server, run from a clone of the repository (not `curl | sh`, so it can be read first). It checks or installs the prerequisites, asks for the Slack tokens, the owner's Slack ID and the model key without echoing them, and then does steps 3 to 6 above. It ends by telling the host to invite the bot and post `@bot register`. gVisor is optional: where it cannot run, the script warns and uses `runc`. This is the biggest blocker for anyone but you, and probably two PRs (prerequisites, then configuration).

Decide first: whether rerunning the script is also the update path, replacing the manual upgrade notes (proposed: yes); and whether the Git proxy stays manual in the first version (proposed: yes, because it needs GitHub branch rules).

### HOST-3: `doctor`

A command for a running install that checks each part and prints the fix for each problem: Slack authentication and scopes, the Socket Mode connection, each channel's server and policy version, the container runtime, firewall rules, inbox ownership and free disk. Today a host reads `journalctl` and the findings instead. It needs root to read `/etc/slack-tag`. Medium.

### LIFE-1: Stop idle projects, start them on the next message

User stories 20 and 21 in `SPEC.md`, whose "Project server lifecycle" section already sets the rules: never stop with work running or an approval pending, keep files and conversations, start the project again on the next message, and report a failed start instead of hiding it. This decides how many guest projects fit on a small server. Medium to large, as two PRs.

Decide first: the idle period (`SPEC.md` leaves it open; 30 minutes is a reasonable start).

### SEC-8: CPU limits and disk warnings

A CPU limit per project container, so one guest's runaway build does not slow everyone, and a Slack warning to the owner when a project folder or its `/data` volume passes a size threshold, before a full disk breaks every project. Small.

Decide first: the default CPU limit and the warning threshold.

### MODEL-1: Other model providers

`key-proxy` forwards only to OpenCode Go. This lets the host use another provider's API key, such as OpenRouter, Anthropic or OpenAI, keeping the rule that the key never enters a project container. Some hosts already pay for a key, and Go is one provider in beta. `/model` today lists models from one provider only. Medium.

Decide first: one provider per install or per project.

## Not proposed now

- A hosted version run for other hosts: only after a few people self-host it successfully.
- Kubernetes or Helm charts, and several Slack workspaces per install.

## Suggested order, once approved

HOST-1, then HOST-2, then HOST-3. Add LIFE-1 and SEC-8 when a host runs more than a few projects, and MODEL-1 when someone asks for it.
