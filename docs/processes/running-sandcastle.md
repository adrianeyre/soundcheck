# Running Sandcastle

[Sandcastle](https://github.com/mattpocock/sandcastle) runs a coding agent
against this repository inside a container and brings the commits it makes back
to a branch. It is how AFK work gets done here: an issue carrying a queue label
([`issue-lifecycle.md`](issue-lifecycle.md)) is picked up by an agent in a
sandbox rather than by a person at this checkout.

`.sandcastle/` holds the configuration. This file says how to use it in this
project, and what an agent running here has to be told.

## What is in `.sandcastle/`

| Path           | What it is                                                             |
| -------------- | ---------------------------------------------------------------------- |
| `Dockerfile`   | The sandbox image — Node 26, git, `gh`, the Claude Code CLI            |
| `main.ts`      | The orchestration entrypoint: which prompt, which sandbox, which hooks |
| `prompt.md`    | The worked example of what a prompt here has to contain                |
| `prompt-*.md`  | A run's own prompt — **gitignored**, written per job and not kept      |
| `.env.example` | The tokens a run needs, with nothing filled in                         |
| `.gitignore`   | Keeps `.env`, `logs/`, `worktrees/` and run reports out of git         |

`logs/` and `worktrees/` appear the first time you run something. Both are
ignored, and so is `.env` — **never commit a token**.

## One-time setup

**1. A container runtime.** Docker Desktop or the Docker engine, running:
`docker info` should print rather than fail. Sandcastle also supports Podman and
Vercel; the configuration committed here is the Docker one, so
`.sandcastle/Dockerfile` and the `docker()` call in `main.ts` are what you edit.

**2. Tokens.**

```bash
cp .sandcastle/.env.example .sandcastle/.env
claude setup-token          # prints a CLAUDE_CODE_OAUTH_TOKEN
```

Paste that into `CLAUDE_CODE_OAUTH_TOKEN` to run the agent on your Claude
subscription, or uncomment `ANTHROPIC_API_KEY` and use a key instead. `GH_TOKEN`
is a [fine-grained token](https://github.com/settings/personal-access-tokens/new)
with **Issues: read and write** and **Metadata: read** — the agent uses it to
read the queue and comment on issues. Sandcastle finds all three itself; nothing
needs threading through the API.

**A key named with no value is filled from your shell.** Sandcastle forwards
exactly the keys `.sandcastle/.env` names, taking the file's value where there
is one and `process.env`'s where there is not. That is worth knowing rather
than working around: a secret already exported on your machine reaches the
sandbox without ever being written to a file, so

```bash
ANTHROPIC_BASE_URL=
ANTHROPIC_API_KEY=
```

is a complete instruction and not an unfinished one. The corollary is the
failure mode: a variable your shell exports and `.env` does not name is **not**
forwarded, and the agent comes up unauthenticated with nothing in the log to
say a variable was dropped.

**A private CA needs the file, not the path.** If Anthropic is reached through
a gateway with its own certificate authority, `NODE_EXTRA_CA_CERTS` on the host
names a file the container cannot see, so forwarding the variable alone leaves
the agent's first request failing to verify. `main.ts` mounts the certificate
and re-points the variable at where it landed:

```ts
const hostCaCert = process.env.NODE_EXTRA_CA_CERTS;
const caCertInSandbox = '/home/agent/ca-certificates.pem';
```

The container also has to be able to route to the gateway. An internal
hostname resolving to a private address works on Docker's default bridge; a
gateway reachable only through the host's loopback does not, and wants
`network: 'host'` on the `docker()` call.

**3. Build the image.**

```bash
npx sandcastle docker build-image
```

It builds `.sandcastle/Dockerfile` as `sandcastle:<repo-dir-name>` and forwards
`AGENT_UID`/`AGENT_GID` from your own user, so files the image writes and files
the bind mount writes share an owner. Run it again after any Dockerfile edit;
`npx sandcastle docker remove-image` throws it away.

## The image has to match this project's Node

`package.json` declares `"node": ">=26"` and CI runs on 26, so the base image is
`node:26-trixie` (Debian 13: the ONNX Runtime the desktop links for Stem
Separation needs glibc 2.38, newer than bookworm's). If you rebase past a
change to that line, check the two still agree: a sandbox on an older Node
installs happily — `engines` is a warning, not a wall — and then fails somewhere
further in, which is a much worse place to find out.

Whatever else you add to the image, keep the four things Sandcastle needs: the
non-root `agent` user (Claude Code refuses to run as root), `git` for the
commits, `gh` for the issues, and `claude` on `PATH`.

## Dependencies are a hook's job, not the image's

The image deliberately installs no project dependencies — they would be baked in
at build time and stale by the next `npm install`. Install them when the sandbox
comes up instead:

```ts
import { run, claudeCode } from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';

await run({
  agent: claudeCode('claude-opus-5-5'),
  sandbox: docker(),
  promptFile: './.sandcastle/prompt.md',
  branchStrategy: { type: 'branch', branch: 'sandcastle/queue' },
  hooks: {
    sandbox: {
      onSandboxReady: [{ command: 'npm ci', timeoutMs: 300_000 }],
    },
  },
});
```

Docker is a bind-mount provider, so the worktree the agent works in is the
worktree on your disk: `npm ci` inside the sandbox writes `node_modules` into
`.sandcastle/worktrees/…` on the host, and an edit the agent makes is on your
disk the moment it makes it. There is no sync step, because nothing was ever a
copy — what does move afterwards is the commits, and that is the branch
strategy's job.

### `onSandboxReady` hooks run in parallel

The list is not a script. Sandcastle runs it with `concurrency: "unbounded"`,
so a second hook starts at the same instant as `npm ci` rather than after it —
and anything in that second hook that needs `node_modules` is racing the
install it depends on. The Virtual Theatre run below fetches four games with
`npm run fetch:vt`, which is `vite-node`, which is a devDependency, and listing
those as siblings of `npm ci` failed the run on

    sh: 1: vite-node: not found

which names the symptom and says nothing about the cause. Chain them into one
hook when order matters:

```ts
onSandboxReady: [{ command: 'npm ci && npm run fetch:vt -- …', timeoutMs: 1_800_000 }];
```

One hook then carries one timeout covering both halves, so it is a budget for
the pair rather than for either — and that is worth stating in the code rather
than discovering when a slow link trips an install-sized timeout.

## A ScummVM checkout is a mount too, when the host has one

`README.md` names ScummVM as the reference implementation this project checks
itself against, and `bin/agos-gen-tables.ts` already takes a checkout as an
argument — "it is not vendored into this repository", for the same reason game
data never is. `main.ts` offers that argument to an agent as well as to a
script: a checkout at **`temp/scummvm`** is mounted read-only at
**`/home/agent/scummvm`**, and skipped when it is not there.

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/scummvm/scummvm.git temp/scummvm
cd temp/scummvm && git sparse-checkout set engines/agos
```

Eleven megabytes for the AGOS engine, and `temp/` is gitignored.

**It is a reference for meaning, never a source to copy tables from.** ADR 0029
says the opcode tables are generated by `npm run gen:agos-tables` and that
hand-editing the output is the one thing forbidden; what a checkout answers is
the question generation cannot — what an opcode _does_. The `simon2` run is the
argument for it: with no checkout it spent most of an iteration establishing
operand orders empirically and still took the obvious wrong guess on one of them
(`vc3_loadSprite` reads the window first and the zone second), which is a
gameplay bug rather than a decode error and therefore silent.

## Game data is a mount, not an image layer

A game's bytes belong on the machine of the person who owns the game. They do
not belong in the image, where a `docker save` carries them off; they do not
belong in a commit; and they do not belong in a layer cache. So a run that
needs one bind-mounts it read-only, and `main.ts` does that from a list of
folder names:

```ts
const GAME_FOLDERS = ['dott', 'fate', 'kq3', 'kq4'] as const;

const gameMounts: MountConfig[] = GAME_FOLDERS.map((name) => ({
  hostPath: resolve('temp', name),
  sandboxPath: `/home/agent/games/${name}`,
  readonly: true,
})).filter((mount) => existsSync(mount.hostPath));
```

Four titles for four families' worth of evidence: Day of the Tentacle and Fate
of Atlantis are the SCUMM pair, King's Quest III is AGI v2 and King's Quest IV
is the SCI0 release rather than the AGI v3 one — each folder's `README.md` says
which, and for King's Quest IV that sentence is load-bearing, because the game
shipped on both engines.

**Every run gets every folder.** A SCUMM run with King's Quest III mounted
ignores it, and the alternative — a mount list per run — is a second place for
a path to be wrong in exchange for nothing: a read-only bind mount nobody opens
costs a line of `docker run`.

Four things about that are deliberate.

**`readonly: true`, not a convention.** The interpreter never writes to a
game's files and neither should an agent, so the kernel is what says so rather
than the prompt. `npm run shot` is the one command that writes anything, and it
writes PNGs to a folder you name — send it somewhere under the workspace.

**A missing folder is skipped, not an error.** Sandcastle fails sandbox
creation when a `hostPath` does not exist, which would make the run depend on
which games a particular person happens to own. Filtering on `existsSync`
turns that into a smaller matrix instead: a run without Fate of Atlantis
reports v5 as fixture-only rather than refusing to start. Which means **the
prompt has to say which games it actually got** — `main.ts` and `prompt.md`
agree on `/home/agent/games/<name>`, and the prompt lists the folder rather
than assuming it:

```markdown
!`ls -d /home/agent/games/*/ 2>/dev/null || echo 'none mounted'`
```

**The mount path is inside `$HOME`, not the workspace.** Anything under
`/home/agent/workspace` is the git worktree, where an accidental `git add -A`
would stage it. Mounting outside the worktree means no game file is ever a path
git can see.

### Two games are fetched instead, and that is the better shape

Beneath a Steel Sky and Lure of the Temptress are the only complete commercial
games in `docs/released-games.md` whose data a build machine may lawfully
fetch: Revolution released both as freeware in 2003.
[`verifying-version-support.md`](verifying-version-support.md) calls that "the
one place CI can check a game", and the Virtual Theatre run spends it — its
`onSandboxReady` hook fetches four releases rather than mounting any.

That is not a stylistic preference. A mount makes the matrix depend on which
releases one person happened to have downloaded, which is the dependency the
SCUMM run has to live with because there is no lawful alternative. There is one
here, so a fetch is what keeps the run reproducible on a machine that owns
nothing — and the fetched zips land in the worktree's own `games/`, which is
gitignored, so they are no more committable than a mount would be.

The URLs and their licences live in `main.ts` and deliberately not in
`bin/fetch-vt.ts`, which refuses to ship a catalogue because "a rotted link in
a tool like this fails at the moment somebody is trying to diagnose something
else". A rotted link in a run configuration fails an `onSandboxReady` hook
before the agent starts, naming the URL — a different and much better failure.

## Running it

```bash
npx tsx .sandcastle/main.ts
```

That is the command `.sandcastle/main.ts` documents itself with, and which run
it means is [the next section](#choosing-a-run).

`tsx` is not a devDependency of this project — `npx` fetches it on first use,
or add it with `npm i -D tsx` if you would rather pin it. Every other script
here runs under `vite-node`, which is a devDependency; either runner is fine as
long as the one you use handles top-level `await`.

`claudeCode()`'s first argument is the model string handed to the Claude Code
CLI; `main.ts` pins whatever `sandcastle init` wrote, and changing it is a
one-word edit. Its second argument takes `effort`, `env` and `permissionMode` —
and note that setting `permissionMode` replaces Sandcastle's default
`--dangerously-skip-permissions`, which is the flag that makes an AFK run
possible in the first place.

Progress streams to the terminal and a full log lands under `.sandcastle/logs/`.
The path comes back on the result as `logFilePath`, along with `commits`,
`branch` and the completion signal that stopped the loop.

## Choosing a run

`main.ts` takes a run's name as its first argument and resolves everything else
from it:

```bash
npx tsx .sandcastle/main.ts agos-downloads
npx tsx .sandcastle/main.ts agos-downloads --setup=freeware
```

| From the name | What it becomes                                                   |
| ------------- | ----------------------------------------------------------------- |
| prompt        | `.sandcastle/prompt-<name>.md`, or `prompt.md` if absent          |
| branch        | `sandcastle/<name>`                                               |
| report        | `.sandcastle/reports/<name>.md`, mounted at `/home/agent/reports` |

`--setup=` picks what the sandbox does before the agent starts, and is the one
thing a name cannot imply — it is a property of the games a job reads:

| Setup      | What the hook does                                                       |
| ---------- | ------------------------------------------------------------------------ |
| `install`  | `npm ci` — the default, and all most runs need                           |
| `freeware` | `npm ci`, then fetches the Virtual Theatre releases and the Simon 1 demo |
| `vt`       | `npm ci`, then the four Virtual Theatre releases only                    |
| `sludge`   | `npm ci`, then Above The Waves                                           |

**The prompt is a local file, and that is deliberate.** There used to be a
`RUNS` table here pairing nineteen tracked `prompt-*.md` files with branches
and reports, each carrying a paragraph of why that job existed. Every one of
them was the prompt of something that had already shipped. A prompt is written
against measurements taken the day it is launched — [Writing the
prompt](#writing-the-prompt) is the reason — so a committed one is a snapshot
of a tree that no longer exists, and it arrived in every pull request as a file
a reviewer had to skip. They are gitignored now. What survives a run is its
commits and its report, which is what a run is for.

Launching a name with no `prompt-<name>.md` beside it falls back to
`prompt.md`, and the startup line says so in as many words. That is a mistake
worth making cheaply — the example is a template, and a run against it would
produce a report about nothing.

The startup line also names the games it actually mounted, and that line is
worth reading before the run rather than after: a matrix's rows are only as
strong as the data behind them, and the commonest disappointment is a report
full of fixture rows for games you own but had not put in `temp/`. A `freeware`
or `vt` setup is the exception and reads none of them — [it fetches
instead](#two-games-are-fetched-instead-and-that-is-the-better-shape).

## Every run commits to a branch cut from `main`, and ends in a pull request

That is the rule here, and the three parts of it are separable, so all three are
stated:

1. **A named branch**, never the working directory.
2. **Cut from `main`**, never from whatever happens to be checked out.
3. **Pushed, with a pull request opened**, by the run itself before it finishes.

| Strategy        | Where the commits land                                        |
| --------------- | ------------------------------------------------------------- |
| `head`          | Straight into this working directory — no worktree, no branch |
| `merge-to-head` | A temporary worktree branch, merged back to HEAD              |
| `branch`        | A named branch in a worktree, kept                            |

`head` is the default for bind-mount providers, which means the out-of-the-box
behaviour is an agent editing the files you are looking at. Work here ships
through pull requests and CI, and a branch is what you can open one from — so
`main.ts` names one for every run.

### Cut from `main`, and why the default is not good enough

`branchStrategy` takes a **`baseBranch`**, and it defaults to `HEAD`:

```ts
branchStrategy: { type: 'branch', branch: chosen.branch, baseBranch: 'main' },
```

Without it a run's starting point is a property of the branch the operator was
standing on when they typed the command. Two runs of the same name a week apart
are then built on different code and their reports are not comparable; a run
launched from a feature branch carries that feature's unreviewed work into its
own diff, so the pull request at the end is not reviewable as itself. Naming
`main` makes the base the same every time.

**`baseBranch` is ignored when the branch already exists.** That is the right
behaviour — re-running a name continues that branch rather than throwing its
commits away — but it means a stale branch silently keeps a stale base. To
re-cut one:

```bash
git worktree remove --force .sandcastle/worktrees/<name>
git branch -D sandcastle/<name>
```

### Seeding the branch first, when the whole job has to be one pull request

The same "ignored when the branch already exists" rule is what lets a run's own
wiring travel in the run's own pull request. A run that needs new wiring — a
setup hook, a mount, a documented rule — otherwise arrives as two changes: the
wiring on one branch and the commits the run makes on another, which is two
reviews of one piece of work, and the first is a configuration change nobody
can evaluate without the second.

To make it one, cut the branch by hand and commit the wiring to it **before**
launching:

```bash
git checkout -b sandcastle/<name> main
# add the wiring and the doc rows; the prompt itself is gitignored
git commit -m "chore(sandcastle): …"
npx tsx .sandcastle/main.ts <name>
```

Sandcastle then continues that branch instead of cutting a fresh one, and the
run's commits land on top of the wiring that describes them.

Seeding costs two things, and they pull against each other. Sandcastle checks
the run's branch out in `.sandcastle/worktrees/<name>/`, and git refuses the
same branch in two worktrees, so launching while you are standing on it dies
with

    WorktreeError: Branch 'sandcastle/<name>' is already checked out in
    worktree at '…'

But `main.ts` and `prompt-<name>.md` are read from **your** checkout, so
switching to `main` to get out of the way takes any new wiring with it — and
the prompt, being gitignored, is not on either branch to be lost. Stand on a
local twin of the seeded branch instead — same commit, different
name, never pushed:

```bash
git switch -c launch/<name> sandcastle/<name>
npx tsx .sandcastle/main.ts <name>
```

Delete it when the run is done. Its only job is to hold the wiring where the
launcher can read it while the worktree holds the branch. **Tell the prompt
this has happened** — a run that finds unexpected commits on its branch may try
to reset them away, and the prompt is the only place it can be told not to. The
`simon2-editor` prompt has that paragraph under `# Finishing`, along with the
instruction to push to an open pull request rather than opening a second.

Diagnose on the host before you seed, not after. The prompt's value is the
measurements in it, and those come from a checkout with the game data — which
is the same reason the house style is to lead a prompt with a number rather
than a task list.

### The run opens the pull request, not you

The sandbox has `gh` in the image and `GH_TOKEN` from `.sandcastle/.env`, and
the worktree is a bind mount of a real branch in the real repository — so a run
can push and open a pull request itself, and should. A run whose product is
commits nobody has opened a review on is a run whose product is easy to lose.

**Say so in the prompt**, in the same section that asks for the report, because
Sandcastle does not do it for you:

```markdown
# Finishing

Before you emit the completion signal, and after the gates are green and the
tree is clean:

    git fetch origin main
    git merge origin/main

**Resolve any conflict yourself and do not stop on one.** The branch was cut
from `main`, so a conflict means `main` moved while the run was working, and it
is yours to settle: read both sides, keep the intent of each, and never resolve
by taking one side wholesale because it is quicker. Then **run all four gates
again** — a clean merge is not a working one — and commit the merge.

    npm run format:check && npm run lint && npm run typecheck && npm test
    git push -u origin HEAD
    gh pr create --base main --fill

Write the body yourself rather than letting `--fill` take the last commit
message: lead with what a reader can now do that they could not, then one line
per fix saying what established it, then one line per refusal saying which fact
is missing. End it with the attribution line this repository uses.

If the merge, the push or the `gh` call fails, **say so in the report with the
error** and finish anyway — an unpushed branch is still on disk, and a run that
dies trying to open a review has thrown away the work it did. If a conflict is
genuinely beyond you, leave the merge uncommitted, say which files and why, and
push the branch without it rather than committing a resolution you do not
believe.
```

`prompt.md` carries that block. A prompt whose product is evidence rather than
commits should drop it — there is nothing to open a review on — and should say
so in as many words, the way the example's own "Commit nothing" paragraph does.

The last paragraph is the load-bearing one. `GH_TOKEN` expires, a fine-grained
token can be missing **Pull requests: write** even when it has Issues, `main`
can move under a long run, and the first anybody knows of any of it is a run
that ends without the thing it was for.

## Writing the prompt

`prompt.md` is the tracked worked example, and a run's own prompt is a
gitignored `prompt-<name>.md` beside it. Copy the example, replace its
measurements with the ones you took this morning, and launch that. Three pieces
of syntax do the work:

- <code>!&#96;command&#96;</code> is replaced by the command's stdout **before** the
  agent sees the prompt. The commands run inside the sandbox, after the
  `onSandboxReady` hooks, so they see the same repository state the agent will —
  dependencies installed and all. They expand in parallel, and a non-zero exit
  fails the run immediately rather than handing the agent a half-built prompt.
- `{{KEY}}` is filled from `promptArgs`, on the host, before the backticks run —
  so `{{KEY}}` inside a command is resolved by the time the command runs. A
  placeholder with no argument is an error. `{{SOURCE_BRANCH}}` and
  `{{TARGET_BRANCH}}` are built in; passing them yourself is an error.
- `<promise>COMPLETE</promise>` ends the iteration loop early. Sandcastle never
  injects it: it is a convention **your prompt has to ask the agent for**, and a
  prompt that forgets to will run until `maxIterations` or the idle timeout.

A prompt that picks up this project's agent queue looks like this:

```markdown
# Context

Recent commits:

!`git log --oneline -10`

Queued bugs:

!`gh issue list --state open --label bugs-for-agent --json number,title,body,labels,comments --limit 100`

Queued enhancements:

!`gh issue list --state open --label ready-for-agent --json number,title,body,labels,comments --limit 100`

# Task

Pick the single oldest issue from either list above and finish it on
`{{SOURCE_BRANCH}}`. The two lists are separate calls because `--label` twice
means _both labels_, and a queue label is an alternative rather than an extra.

Read `CONTEXT.md` before writing anything: it fixes the vocabulary — Engine
family, Engine, Script engine, Target — and using the wrong word for a thing is
a review comment every time. Decisions already taken live in
`docs/architectural-decision-record/`; do not re-litigate one, and do not
contradict one silently.

These all have to pass before you commit:

    npm run format:check
    npm run lint
    npm run typecheck
    npm test
    npm run build

Commit with [Conventional Commits](https://www.conventionalcommits.org) —
`fix:`, `feat:`, `docs:` — because semantic-release reads the messages to decide
the next version. One commit per coherent change.

Never commit game data. `games/` and `public/games/` are ignored, CI fails on a
dirty tree after fetching anything, and no game's bytes belong in this
repository. Do not claim a game or a Version is supported: that claim has a
process, and it is `docs/processes/verifying-version-support.md`.

Anything you write on an issue opens with
`> *This was generated by AI during triage.*`

# Done

When the issue is finished and every gate above passes, output
<promise>COMPLETE</promise>
```

## What the worked runs taught

Nineteen prompts have been through here, and their files are gone — a prompt is
a snapshot of a tree that has since moved. What they established about _writing_
one is not, and `prompt.md` is where it is applied. Five things, in the order
they cost the most:

**Lead with a measurement, not a task list.** The single most expensive failure
mode is a run told to "implement X" going off to build a subsystem that already
exists. The SCI matrix's documented blocker turned out to be built already, and
the corrected finding — every Kernel call implemented, 140,896 `GetTime` calls
against 10,802 `GetEvent`s — is a pacing fault rather than a missing layer.
Handing a run the old claim would have bought a great deal of new Kernel code
nobody needed. Diagnose on the host, put the numbers in the prompt, and say what
they rule out.

**Three symptoms are often one mistake, and the prompt should say which.** Simon
2 stood still through 6,000 frames with 9,769 refused `animate` calls; three of
its four measured faults were Simon 1's `zone = id / 100` rule applied to a
Version whose animation ids are zone-local. A prompt that lists four faults gets
four investigations. One that names the shared cause gets a fix.

**Hand over a named queue rather than a mystery.** Where the cause is already
known, say so and enumerate the work: "36 of Sky's 115 mcodes are implemented"
and the list of the 79 beats "clicking does nothing". Then tell the agent to
check the list rather than trust it. The failure this is written against is an
agent hunting for a mystery that is not there.

**Say what an improvement is not allowed to claim.** Progress rungs are earned
against a definition — `room` means "a named room is on screen with the player
in control" — and a piece that makes clicking work leaves that rung where it is.
Ask for the honest case out loud: if the click completes and nothing visible
happens, that is a result and it must be reported as one. Same for support:
that claim has a process and it is
[`verifying-version-support.md`](verifying-version-support.md).

**Distinguish a task from an open question.** Some pieces cannot be settled by
an agent at all — transcribing a Huffman tree out of a third party's generated
data is an ADR-sized decision, not an implementation detail (ADR 0024's third
amendment records the pattern surviving four revisions unchecked). Where a
prompt contains one, offer both routes explicitly: write the ADR, or leave the
surface refused and report that as what stopped the piece.

A run's product survives in two places, and neither is its prompt:
`.sandcastle/reports/<name>.md` on the host, and the commits on
`sandcastle/<name>`.

## What a sandbox here cannot do

**It has no games of its own.** Every sweep, diagnose, reexport and shot script
(`npm run sweep:sci`, `npm run shot:agi`, and the rest) reads the files of a
game you own, and this repository ships none — so an agent reaches the
synthetic fixtures and nothing else until you mount something. That is
[the next section](#game-data-is-a-mount-not-an-image-layer), and it is the
difference between a run that can say something about a Version and a run that
can only say something about a fixture.

**Fetching the freeware games needs the network.** `npm run fetch:vt` pulls Lure
of the Temptress and Beneath a Steel Sky from scummvm.org — the only two games
whose bytes CI is allowed to touch (ADRs 0023, 0026). A sandbox
pinned to a network with no egress cannot reach them, which makes the Virtual
Theatre run the one that cannot fall back to a fixture: it has none, so no
egress means no run rather than a weaker one.

**A heavy host command can kill the run.** `DockerOptions` has no memory
field, so the container is unconstrained and competes with whatever the host is
doing. The first `virtual-theatre-play` run died on

    Agent invocation failed: claude-code exited with code 137

which is SIGKILL from the host's OOM killer, not a Node heap error — and it
landed while the host was running `npm test`, `npm run build` and two
`play:vt` sweeps against a 109.8 MB game alongside the container running its
own gates. **So do not run this project's gates on the host while a sandbox is
up.** The agent had finished a piece and was one command from committing it.

What saved that work is worth knowing before you need it: **Sandcastle keeps a
dirty worktree on purpose.** `.sandcastle/worktrees/<branch>/` survived the
kill with the piece's three modified files in it, `git -C … diff` produced a
patch that applied to the merged branch unchanged, and the only thing lost was
the commit message. A clean worktree is deleted when a run closes; a dirty one
is not, and this is the case that rule exists for.

**Nothing renders.** `vitest` runs with `environment: 'node'` and the image has
no browser, so an agent can prove the interpreter's logic and cannot see a
frame. Visual regressions are yours to catch.

## Cleaning up

Worktrees live under `.sandcastle/worktrees/`. A clean one is deleted when the
run closes; a dirty one is kept, on purpose, so uncommitted work survives a
crash — which also means a stale worktree is a thing you will occasionally have
to `git worktree remove` by hand. `npx sandcastle docker remove-image` drops the
image.

## Troubleshooting

| Symptom                                             | Cause                                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ERR_MODULE_NOT_FOUND` for `@ai-hero/…`             | `npm ci` not run at this checkout — the package is a devDependency                        |
| The agent exits asking to authenticate              | `.sandcastle/.env` missing, or `CLAUDE_CODE_OAUTH_TOKEN` empty                            |
| `gh` says the issue queue is empty                  | `GH_TOKEN` has no **Issues: read** on this repository                                     |
| Permission errors on files the agent wrote          | Image built without your UID — rebuild with `npx sandcastle docker build-image`           |
| The run hangs long after the work is done           | The prompt never asked for `<promise>COMPLETE</promise>`                                  |
| Every run edits your working directory              | No `branchStrategy`, so the bind-mount default `head` applied                             |
| `unable to verify the first certificate`            | A private CA forwarded as a host path — mount the file and re-point `NODE_EXTRA_CA_CERTS` |
| The agent is unauthenticated despite a set variable | `.sandcastle/.env` does not name that key, so it was not forwarded                        |
| Sandbox creation fails naming a `hostPath`          | A mounted game folder is not on this machine — Sandcastle requires every mount to exist   |
| A Version reports fixture data you own a game for   | Its folder is not in `GAME_FOLDERS`, or not where `main.ts` resolves it                   |
| `vite-node: not found` in an `onSandboxReady` hook  | Hooks run in parallel — that one raced `npm ci`; chain them with `&&`                     |
| The startup line says it is using the example       | No `prompt-<name>.md` beside `prompt.md` — write one, or check the name for a typo        |
| A `--setup=freeware` or `vt` run dies naming a URL  | A freeware release moved; the URL is in `VT_RELEASES` in `main.ts`                        |

## See also

- [Sandcastle](https://github.com/mattpocock/sandcastle) — the upstream README
  is the reference for `run()`, the agent and sandbox providers, and the hooks
- [`issue-lifecycle.md`](issue-lifecycle.md) — what a queue label means, and what
  an agent brief has to contain before an agent is pointed at it
- [`verifying-version-support.md`](verifying-version-support.md) — the only route
  from "it runs" to a support claim, and what the three matrix runs above are
  and are not evidence for
