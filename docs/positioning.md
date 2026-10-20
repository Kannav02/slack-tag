# Positioning

Proposal, 2026-10-20. Not yet tested with users. Features marked "after" in the last table are planned in [the backlog](backlog.md), not shipped; do not claim them until they land.

## In one sentence

A shared AI teammate for the people you make things with. You host it; they just chat.

## Who it is for

- **The host** is the technical person: a developer or graduate student who works on projects with people who are not technical. They run it on a small server, pay one flat bill and decide what the agent may do.
- **Guests** are everyone else: a parent writing a book, a professor on a research project, a sibling making a game. They talk to it in a chat app they already use. No account, no subscription, nothing to install.

Market to hosts. Guests experience it; they never need to hear how it works.

## The story to tell

Do not open with "I built a Slack bot for OpenCode". That invites the comparison with Claude and Codex. Open with what happened, once it has; the Word file below needs DOC-2:

> My brother and I build our game with one AI teammate in our chat. Either of us can ask it for a change, it works on the actual game files, and it remembers what we did. My mom uses the same thing for her book: she asks for edits and gets the chapter back as a Word file. I host it for all of us for about $20 a month, and none of them needs an account.

The demo is the pitch: a one-minute video of three projects, three people and one teammate.

## When people ask "why not just use …?"

**ChatGPT or Claude.** "Those give each person a private chat. This is one teammate for the whole group, working on the group's real files." If my mom and I both use ChatGPT on her book, we each paste chapters into our own chats and never see each other's work. Here there is one copy of the book and one assistant, and we both talk to it in the same place. It is Google Docs versus emailing Word files around. It also does the work instead of suggesting it: it edits the files, runs the game and sends back the result.

**Claude Code, Codex or Cursor.** "Those are for programmers: terminals, GitHub, pull requests, one account per person. My mom is not opening a terminal."

**Claude Tag or Capy.** "They are built for software teams: GitHub repositories, pull requests, code review, and Claude Tag needs a Team or Enterprise plan. This is for a family, a lab or a few friends, with files that are not always code." If the person asking runs a software team at a company, say the big tools fit them better. Saying so earns trust.

**OpenClaw.** "OpenClaw is one person's assistant with access to their computer and accounts. Sharing it shares all of that. Here every project is sealed off, the agent never sees keys or passwords, and anything risky waits for my OK."

**"Is it safe to give my mom an agent that runs commands?"** Each project runs in its own sandbox and cannot see other projects or the server. The model key and GitHub login stay outside the sandbox. Anything outside a known-safe list waits for the host's approval, and no answer means no. See [trust boundaries](trust-boundaries.md).

**"What does it cost?"** The host pays for a small server and a model plan (OpenCode Go is $10 a month); guests pay nothing. Model plans have usage limits, and heavy use may hit them. Check the plan's terms before you promise one subscription for a whole group.

## What not to say

- Do not lead with Slack, OpenCode, gVisor, self-hosting or "agent". Those details are for hosts who ask how it works.
- Do not compete for software teams at companies. Claude Tag, Codex, Cursor and Capy serve them well.
- Do not claim a feature before it ships.

## Where to find hosts

1. Your own guests first. Their stories are the launch material.
2. Show HN, r/selfhosted, the OpenCode community and graduate student groups, with the one-minute video: "Give the people you make things with a shared AI teammate."
3. Measure two numbers: hosts who install it, and guests per host who use it each week.

## What we can claim today

| Claim | Status |
| --- | --- |
| One shared thread per conversation, with memory, that anyone in the channel can join | Today |
| Works on the project's real files; sends back images, logs and text files | Today |
| Each project sealed off; keys outside the sandbox; risky steps wait for the host | Today |
| Short, plain replies that lead with the result | After GUEST-1 |
| People can talk in a thread; only messages to the bot reach it | After GUEST-3 |
| Word and PDF files in and out | After DOC-1, DOC-2 |
| A help message with its models, commands and how it proves its work | After GUEST-5 |
| A new project from the chat | After ONB-2 |
| Install in one command | Proposed in [hosting](hosting.md) (HOST-1, HOST-2) |
