import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import plugin from "../plugin/index.ts";

type Attached = { metadata: { slackAttach: string } };
type Tool = {
  name: string;
  execute(input: unknown, ctx: { sessionID: string }): Promise<Attached>;
};
type Take = (input: { sessionID: string; id: string }) => Promise<{ data?: string }>;

// Loads the plugin as OpenCode does for a session in `directory` and returns its slack_attach tool and
// the attachment RPC the bridge fetches accepted files with. Files are read through /bin/sh here.
async function slackAttach(directory: string) {
  let tool: Tool | undefined;
  let take: Take | undefined;
  const host = {
    location: { directory },
    rpc: {
      register: async (_definition: unknown, methods: { attachment: Take }) => {
        take = methods.attachment;
      },
    },
    permission: { hook: async () => undefined },
    shell: { hook: async () => undefined },
    session: { hook: async () => undefined },
    // setup also adds open_pull_request; keep slack_attach.
    tool: {
      transform: async (edit: (tools: { add(added: Tool): void }) => void) =>
        edit({
          add: (added) => {
            if (added.name === "slack_attach") tool = added;
          },
        }),
    },
    command: { transform: async () => undefined },
  };
  await plugin.setup(host as unknown as Parameters<typeof plugin.setup>[0]);
  assert.ok(tool && take);
  return { tool, take };
}

await test("slack_attach sends Word, ODT, EPUB and PDF files only when their content matches", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "slack-tag-attach-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { tool, take } = await slackAttach(dir);
  const attach = (path: string) => tool.execute({ path }, { sessionID: "ses_1" });
  // Word, ODT and EPUB files are ZIP archives and a PDF starts with %PDF-; being binary, they may hold NUL.
  const zip = Buffer.from("504b0304140000000800", "hex");
  const pdf = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n\0", "latin1");
  const accepted: [string, Buffer][] = [
    ["a.docx", zip],
    ["a.odt", zip],
    ["a.epub", zip],
    ["Paper.PDF", pdf],
  ];
  const refused: [string, Buffer | string, RegExp][] = [
    ["text.pdf", "not a pdf", /the content is not pdf/],
    ["zip.pdf", zip, /the content is not pdf/],
    ["pdf.docx", pdf, /the content is not docx/],
    ["big.docx", Buffer.concat([zip, Buffer.alloc(10 * 1024 * 1024)]), /larger than 10 MB/],
  ];
  for (const [name, data] of [...accepted, ...refused]) await writeFile(join(dir, name), data);

  // Accepted files reach the bridge byte for byte.
  for (const [name, data] of accepted) {
    const { metadata } = await attach(name);
    const file = await take({ sessionID: "ses_1", id: metadata.slackAttach });
    assert.equal(file.data, data.toString("base64"), name);
  }
  for (const [name, , error] of refused) await assert.rejects(attach(name), error, name);
});
