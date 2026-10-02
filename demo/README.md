# Local demo

Runs the real bridge (`bridge/src/main.ts`, Bolt in Socket Mode) against `fake-slack.mjs`, a local stand-in for Slack, and OpenCode 2.0.15 with the safety plugin. The fake serves the Web API methods the bridge calls, a Socket Mode websocket, and a browser page with two channels, a user switcher, threads, uploads, and approval buttons. The bridge reaches it through `SLACK_API_URL`; without that variable it talks to slack.com.

## Host OpenCode

```bash
OPENCODE_API_KEY=<OpenCode Go key> demo/run.sh
```

Open http://127.0.0.1:3000. `#demo` is mapped to `/tmp/slack-tag-demo/project`, which gets an `AGENTS.md` ("End every reply with the word PINEAPPLE.") and a `facts.txt` ("The project codename is HERON."). `#unmapped` is not mapped. The right-hand panel lists the project folder on the host.

Optional variables: `DEMO_DIR`, `DEMO_PROJECT`, `FAKE_SLACK_PORT` (3000), `OPENCODE_PORT` (4096), `MODEL` (`opencode-go/kimi-k2.7-code`), `OPENCODE_SERVER_PASSWORD` (random).

## Container OpenCode

Start a channel container as `docs/deploy.md` describes, with the same `OPENCODE_SERVER_PASSWORD` in its env file (`alpha.env`), then point the demo at it:

```bash
deploy/prepare-project.sh /srv/demo/alpha
ALPHA_PROJECT=/srv/demo/alpha ALPHA_ENV_FILE=/path/to/alpha.env SLACK_TAG_RUNTIME=runsc \
  docker compose -f deploy/compose.yaml up -d --build alpha
OPENCODE_API_KEY=<key> OPENCODE_SERVER_PASSWORD=<same password> DEMO_PROJECT=/srv/demo/alpha \
  OPENCODE_URL=http://127.0.0.1:4101 SERVER_DIR=/project demo/run.sh
```

## Things to try

| Post in `#demo` as the owner | Expected |
| --- | --- |
| `@OpenCode what is the project codename in facts.txt?` | A thread reply that grows through edits and ends with HERON and PINEAPPLE. |
| `Write three short paragraphs about herons.` in that thread | A longer streamed reply in the same session. |
| `@OpenCode use the shell to run exactly: touch approved.txt, then reply DONE` | The command runs automatically under policy version 2; `approved.txt` appears in the side panel. |
| Ask it to run `sudo touch /tmp/slack-tag-denied` | The hard block rejects the command; independently check that no file was created. |
| Attach a PNG with `@OpenCode what colour is this image? One word.` | The file lands in `.slack-tag/inbox/<thread>/`, and the model answers. |
| `@OpenCode` as "Other user", or in `#unmapped` | An ephemeral owner-only refusal, or "not mapped". |

The fake Slack page approximates rendering. Verify Markdown visually in a development Slack workspace before claiming real Slack rendering works.
