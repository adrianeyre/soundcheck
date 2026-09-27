/**
 * The Sandcastle entrypoint for this repository.
 *
 *   pnpm sandcastle 39                       # ./.sandcastle/prompt.md, against issue #39
 *   pnpm sandcastle prompt-issue-39.md 39    # a prompt you wrote beside it
 *   pnpm sandcastle                          # only for a prompt naming no issue
 *
 * `docs/processes/running-sandcastle.md` is the prose. This is the wiring, and
 * the four things it wires that the blank template does not are the reason that
 * file has a section each: a private CA is forwarded when the host reaches
 * Anthropic through one, dependencies are installed by a hook rather than baked
 * into the image, the commits are merged back to the branch you launched from
 * rather than landing in your working directory, and the prompt is chosen at
 * the command line rather than fixed.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import type { MountConfig } from "@ai-hero/sandcastle";

/**
 * A private CA, when the host is talking to Anthropic through one.
 *
 * `NODE_EXTRA_CA_CERTS` on the host names a file the container cannot see, so
 * forwarding the variable alone leaves the agent's first request failing to
 * verify and the run dying before the prompt is read. The file is mounted and
 * the variable re-pointed at where it landed.
 *
 * Absent on a host that talks to Anthropic directly, which is why this is a
 * condition rather than a required mount.
 */
const hostCaCert = process.env.NODE_EXTRA_CA_CERTS;
const caCertInSandbox = "/home/agent/ca-certificates.pem";
const forwardCaCert = Boolean(hostCaCert && existsSync(hostCaCert));

const mounts: MountConfig[] =
  forwardCaCert && hostCaCert
    ? [{ hostPath: hostCaCert, sandboxPath: caCertInSandbox, readonly: true }]
    : [];

/**
 * What every run needs before the agent starts.
 *
 * The image deliberately installs no workspace dependencies: they would be
 * baked in at build time and stale by the next lockfile change. Installing on
 * sandbox-ready instead means the agent always gets the tree's own versions.
 *
 * `--frozen-lockfile` is deliberate and it is the same flag CI uses. A slice
 * that legitimately adds a dependency has to update the lockfile as part of its
 * commit, which is what makes the lockfile reviewable; an install that quietly
 * resolved something new would hide exactly that.
 *
 * Two notes on the shape of this list. **`onSandboxReady` hooks run in
 * parallel** — Sandcastle runs them unbounded — so a hook that needs
 * `node_modules` must not be a sibling of the hook that installs it; chain with
 * `&&` rather than adding an entry. And `corepack` is what puts pnpm at the
 * version `packageManager` pins, so the sandbox and this checkout agree.
 */
const SETUP = [
  {
    command: "corepack pnpm install --frozen-lockfile",
    timeoutMs: 600_000,
  },
] as const;

/**
 * Where prompts live, and the one of them git tracks.
 *
 * `.sandcastle/.gitignore` ignores every `prompt*.md` except `prompt.md`, so a
 * brief you write for the slice in front of you is yours and does not ride
 * along in the branch's diff. `prompt.md` is the committed template you copy —
 * it carries the five parts a prompt in this repository has to have, which is
 * the part that is easy to forget and expensive to get wrong.
 */
const PROMPT_DIR = "./.sandcastle";
const DEFAULT_PROMPT = "prompt.md";

const usage = (): void => {
  console.error(
    "Usage:\n" +
      "  pnpm sandcastle <issue>                # ./.sandcastle/prompt.md, against that issue\n" +
      "  pnpm sandcastle <prompt.md> <issue>    # a prompt beside it\n" +
      "  pnpm sandcastle                        # only for a prompt naming no issue\n\n" +
      `Prompts live in ${PROMPT_DIR}/. Copy ${DEFAULT_PROMPT} rather than editing it:\n` +
      `  cp ${PROMPT_DIR}/${DEFAULT_PROMPT} ${PROMPT_DIR}/prompt-issue-39.md\n`,
  );
};

// `pnpm sandcastle 39` is the common case, so a bare number is read as the
// issue rather than as a file nobody has named `39`.
const args = process.argv.slice(2);
const firstIsIssue = args[0] !== undefined && /^\d+$/.test(args[0]);
const promptArg = firstIsIssue ? DEFAULT_PROMPT : (args[0] ?? DEFAULT_PROMPT);
const issueArg = firstIsIssue ? args[0] : args[1];

const promptFile = promptArg.includes("/")
  ? promptArg
  : `${PROMPT_DIR}/${promptArg}`;

if (!existsSync(promptFile)) {
  console.error(`No prompt at "${promptFile}".\n`);
  usage();
  process.exit(1);
}

/**
 * `{{ISSUE}}` is filled on the host before the prompt's backticked commands
 * run, which is how it reaches the `gh api` call that fetches the brief. A
 * placeholder Sandcastle cannot fill fails the run *after* the sandbox is
 * built, so it is cheaper to refuse here — and a prompt that names no issue is
 * legitimate, so this is a condition rather than a required argument.
 */
const promptBody = readFileSync(promptFile, "utf8");
const needsIssue = promptBody.includes("{{ISSUE}}");

if (needsIssue && issueArg === undefined) {
  console.error(
    `"${promptFile}" contains {{ISSUE}}, so it needs an issue number.\n`,
  );
  usage();
  process.exit(1);
}

// Built rather than ternary'd: `{}` in a conditional widens to `{ ISSUE?: undefined }`,
// which Sandcastle's `PromptArgs` index signature refuses.
const promptArgs: Record<string, string> = {};
if (needsIssue && issueArg !== undefined) promptArgs.ISSUE = issueArg;

/**
 * The branch the commits are merged back to — the one you launched from.
 *
 * `head` is Sandcastle's default for bind-mount providers, and it means an agent
 * editing the files you are looking at. `merge-to-head` gives the agent its own
 * worktree and branch and merges the result back here when it finishes, so the
 * work arrives as commits on a branch a pull request can open from — which is
 * how anything ships in this repository.
 *
 * Launch from a branch, never from `main`. The guard below is not politeness:
 * a run on `main` merges an agent's unreviewed commits straight onto the
 * trunk of the repository that holds the economy.
 */
const targetBranch = execFileSync(
  "git",
  ["rev-parse", "--abbrev-ref", "HEAD"],
  {
    encoding: "utf8",
  },
).trim();

if (targetBranch === "main") {
  console.error(
    "Refusing to run on `main`: `merge-to-head` would merge unreviewed agent\n" +
      "commits onto the trunk. Cut a branch first, e.g.\n\n" +
      `  git checkout -b slice-35-the-next-thing origin/main\n`,
  );
  process.exit(1);
}

console.log("Sandcastle run");
console.log(`  prompt   ${promptFile}`);
console.log(`  issue    ${issueArg === undefined ? "none" : `#${issueArg}`}`);
console.log(`  branch   ${targetBranch} (via merge-to-head)`);
console.log(`  CA       ${forwardCaCert ? hostCaCert : "none forwarded"}`);

const result = await run({
  agent: claudeCode("claude-opus-5-5", { effort: "high" }),
  sandbox: docker({
    mounts,
    // Re-point the variable at the mounted copy. Forwarding the host path alone
    // is the `unable to verify the first certificate` failure.
    env: forwardCaCert ? { NODE_EXTRA_CA_CERTS: caCertInSandbox } : {},
  }),
  promptFile,
  promptArgs,
  branchStrategy: { type: "merge-to-head" },
  maxIterations: 6,
  idleTimeoutSeconds: 1_800,
  hooks: {
    sandbox: {
      onSandboxReady: [...SETUP],
    },
  },
});

console.log(`\nDone. ${result.commits.length} commit(s) on ${targetBranch}.`);
console.log(
  `  signal   ${result.completionSignal ?? "none — hit maxIterations or the idle timeout"}`,
);
if (result.logFilePath) console.log(`  log      ${result.logFilePath}`);
// A worktree is deleted when it closes clean and KEPT when it does not, so that
// uncommitted work survives a crash. That is also the only warning you get that
// the run left something behind.
if (result.preservedWorktreePath) {
  console.log(
    `  kept     ${result.preservedWorktreePath} — uncommitted changes; \`git worktree remove\` when done`,
  );
}
