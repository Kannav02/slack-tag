import type { Plugin } from "@opencode/plugin";

type Prompt = Parameters<Plugin.Context["session"]["prompt"]>[0];

// The /fix workflow, kept short and concrete for small models.
const template = (problem: string) => `Fix this problem: ${problem}

Work in this order:
1. Reproduce it before changing anything: run the test, script or command that shows the problem. Don't redirect its output to a file; Slack gets every command's output. For a page, save a screenshot with \`playwright screenshot <url> /tmp/fix-before.png\`.
2. Fix it with the smallest change that works.
3. Run the same checks again (for a page, save /tmp/fix-after.png).
4. Post any screenshots with slack_attach.
5. Switch to a new branch named jeff/<short-slug>, commit the fix and push it. If the open_pull_request tool is available, call it.
6. End your reply with exactly these four sections:
**What changed:** one or two sentences.
**Pull request:** the link, or why there is none.
**Evidence:** each check you ran, before and after, and its result.
**Not verified:** anything you could not reproduce, run or check, or "Nothing".

Slack also gets a log of every shell command you run. Never say a check passed unless you ran it and saw it pass. If you could not reproduce the problem, say so plainly.`;

// Registered like OpenCode's own /review: the command expands its template and prompts the same session.
export async function fix(ctx: Plugin.Context) {
  await ctx.command.transform((commands) => {
    commands.add({
      name: "fix",
      description: "reproduce a problem, fix it, and prove it with before and after evidence",
      execute: async ({ sessionID, prompt: { text, ...rest }, delivery }) => {
        const problem = text.trim() || "the problem described earlier in this thread";
        // Attachments and mentions pass through. The schema type allows explicit undefined in
        // optional fields, which the client type does not.
        const input = { ...rest, sessionID, text: template(problem), delivery } as Prompt;
        await ctx.session.prompt(input);
      },
    });
  });
}
