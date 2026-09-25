const SECRET = /xox[baprs]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+/g

export function redact(text: string) {
  return text.replace(SECRET, "[redacted]")
}

export type SlackApi = {
  post(channel: string, threadTs: string, text: string): Promise<string>
  update(channel: string, ts: string, text: string): Promise<void>
  ephemeral(channel: string, user: string, text: string): Promise<void>
}

type SayClient = {
  chat: {
    postMessage: (args: { channel: string; thread_ts: string; text: string }) => Promise<{ ts?: string }>
    update: (args: { channel: string; ts: string; text: string }) => Promise<unknown>
    postEphemeral: (args: { channel: string; user: string; text: string }) => Promise<unknown>
  }
}

export function slackApi(client: SayClient): SlackApi {
  return {
    async post(channel, threadTs, text) {
      const posted = await client.chat.postMessage({ channel, thread_ts: threadTs, text: redact(text) })
      if (!posted.ts) throw new Error("Slack did not return a message ts")
      return posted.ts
    },
    async update(channel, ts, text) {
      await client.chat.update({ channel, ts, text: redact(text) })
    },
    async ephemeral(channel, user, text) {
      await client.chat.postEphemeral({ channel, user, text: redact(text) })
    },
  }
}
