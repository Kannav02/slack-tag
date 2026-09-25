import bolt from "@slack/bolt"

const { App } = bolt
import type { Ask } from "./agent.ts"
import type { createApprovals } from "./approvals.ts"

type Approvals = ReturnType<typeof createApprovals>

function valueOf(ask: Ask) {
  return JSON.stringify({ sessionID: ask.sessionID, requestID: ask.requestID })
}

export function startSlack(approvals: Approvals, ownerUserId: string) {
  const token = process.env.SLACK_BOT_TOKEN
  const appToken = process.env.SLACK_APP_TOKEN
  if (!token || !appToken) return

  const app = new App({ token, appToken, socketMode: true })

  async function onClick(decision: "once" | "reject", args: { ack: () => Promise<void>; body: any; action: any; client: any }) {
    await args.ack()
    const userId = args.body.user?.id ?? ""
    const parsed = JSON.parse(args.action.value) as { requestID: string }
    const result = await approvals.decide({ userId, requestID: parsed.requestID, decision })
    if (!result.ok) {
      await args.client.chat.postEphemeral({
        channel: args.body.channel?.id,
        user: userId,
        thread_ts: args.body.message?.thread_ts ?? args.body.message?.ts,
        text: result.reply,
      })
    }
  }

  app.action("approve", async (args) => onClick("once", args as any))
  app.action("reject", async (args) => onClick("reject", args as any))

  approvals.subscribe(() => {
    const fresh = approvals.prompts.filter((prompt) => prompt.state === "pending" && !(prompt as Ask & { posted?: boolean }).posted)
    for (const prompt of fresh) {
      ;(prompt as Ask & { posted?: boolean }).posted = true
      const channel = process.env.SLACK_CHANNEL_ID
      const thread = process.env.SLACK_THREAD_TS
      if (!channel) continue
      void app.client.chat.postMessage({
        channel,
        thread_ts: thread,
        text: `Approval needed: ${prompt.command}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*${prompt.action}*\n\`${prompt.command}\`` } },
          {
            type: "actions",
            elements: [
              { type: "button", style: "primary", action_id: "approve", text: { type: "plain_text", text: "Approve" }, value: valueOf(prompt) },
              { type: "button", style: "danger", action_id: "reject", text: { type: "plain_text", text: "Reject" }, value: valueOf(prompt) },
            ],
          },
        ],
      })
    }
  })

  void app.start().then(() => console.log("slack socket mode connected"))
  console.log(`slack owner ${ownerUserId}`)
}
