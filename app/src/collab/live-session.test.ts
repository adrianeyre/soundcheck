import { afterEach, expect, test, vi } from "vitest";

import { SYNC_VERSION } from "../project/change";
import type { Command } from "../project/commands";
import type { LoadedSamples } from "../project/engine-sync";
import { sampleProject } from "../project/fixtures";
import { ProjectHistory } from "../project/history";
import { createAudioTrack, createProject } from "../project/model";
import { parseProject, serialiseProject } from "../project/serialise";
import { FakeRelay } from "./fake-relay";
import { type LiveSessionOptions, LiveSession, type LiveStatus } from "./live-session";
import { encodeMessage, importKey, type Invite, newInvite, PART, seal, split } from "./live-wire";

/** One member of a Live Session, and what it has been told. */
interface Member {
  session: LiveSession;
  samples: LoadedSamples;
  statuses: LiveStatus[];
  members: string[];
  adopted: ProjectHistory[];
  history: () => ProjectHistory;
}

const sessions: LiveSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.leave();
});

function join(
  relay: FakeRelay,
  invite: Invite,
  history: ProjectHistory,
  joining: boolean,
  options: Omit<Partial<LiveSessionOptions>, "samples"> & { samples?: LoadedSamples } = {},
): Member {
  const member: Member = {
    session: undefined as unknown as LiveSession,
    samples: options.samples ?? new Map(),
    statuses: [],
    members: [],
    adopted: [],
    history: () => member.session.history,
  };
  member.session = new LiveSession({
    invite,
    history,
    joining,
    connect: relay.connect,
    retryAfter: () => 5,
    onAudio: (added) => {
      member.samples = new Map([...member.samples, ...added]);
    },
    onProject: (adopted) => member.adopted.push(adopted),
    onStatus: (status) => member.statuses.push(status),
    onMembers: (names) => {
      member.members = names;
    },
    ...options,
    samples: () => member.samples,
  });
  sessions.push(member.session);
  return member;
}

function run(member: Member, commands: Command | Command[]) {
  const result = member.history().execute(commands);
  if (!result.ok) throw new Error(result.error);
}

const status = (member: Member) => member.statuses.at(-1)?.kind;

/**
 * Bob opens the invite link with nothing open, before Alice has started the
 * Live Session with her Project, and edits his own while he waits.
 */
async function aliceAndBob(relay = new FakeRelay(), invite = newInvite("wss://relay.test")) {
  const own = new ProjectHistory(createProject("Untitled"), { copy: "bob", by: "Bob" });
  const bob = join(relay, invite, own, true);
  await vi.waitFor(() => expect(status(bob)).toBe("waiting"));
  own.execute({ type: "setTempo", tempo: 60 });
  const alice = join(relay, invite, new ProjectHistory(sampleProject(), { copy: "alice", by: "Alice" }), false);
  await vi.waitFor(() => expect(status(bob)).toBe("live"));
  return { relay, invite, alice, bob };
}

test("someone joining from an invite link is sent the session's Project, and then each sees the other's Changes", async () => {
  const { relay, alice, bob } = await aliceAndBob();
  expect(bob.adopted).toHaveLength(1);
  expect(bob.history()).toBe(bob.adopted[0]);
  expect(bob.history().copy).toBe("bob");
  expect(bob.history().project).toEqual(alice.history().project);
  await vi.waitFor(() => expect(alice.members).toEqual(["Bob"]));
  expect(bob.members).toEqual(["Alice"]);
  // What Bob did to his own Project while he waited went nowhere.
  expect(alice.history().log.every((change) => change.copy === "alice")).toBe(true);

  run(alice, { type: "setTempo", tempo: 90 });
  run(bob, { type: "renameTrack", trackId: "keys", name: "Piano" });
  await vi.waitFor(() => expect(bob.history().project.tempo).toBe(90));
  await vi.waitFor(() => expect(alice.history().project.tracks[0]!.name).toBe("Piano"));
  expect(alice.history().project).toEqual(bob.history().project);

  // The Relay passed it all on without being able to read any of it.
  const everything = relay.seen.map((frame) => new TextDecoder().decode(frame)).join("");
  expect(everything).not.toContain("Piano");
  expect(everything).not.toContain("setTempo");
  expect(everything).not.toContain(sampleProject().name);
});

test("undo in a Live Session undoes only your own, while someone else edits", async () => {
  const { alice, bob } = await aliceAndBob();
  run(alice, { type: "setTempo", tempo: 90 });
  await vi.waitFor(() => expect(bob.history().project.tempo).toBe(90));
  run(bob, { type: "renameTrack", trackId: "keys", name: "Piano" });
  await vi.waitFor(() => expect(alice.history().project.tracks[0]!.name).toBe("Piano"));

  expect(alice.history().undo()).toBe(true);
  await vi.waitFor(() => expect(bob.history().project.tempo).toBe(120));
  expect(bob.history().project.tracks[0]!.name).toBe("Piano");
  expect(alice.history().project).toEqual(bob.history().project);
});

test("what each did while the Relay was out of reach is caught up once they reconnect", async () => {
  const { relay, alice, bob } = await aliceAndBob();
  relay.down = true;
  relay.drop();
  await vi.waitFor(() => expect(status(alice)).toBe("reconnecting"));
  run(alice, { type: "setTempo", tempo: 90 });
  run(bob, { type: "renameTrack", trackId: "keys", name: "Piano" });
  run(bob, { type: "renameTrack", trackId: "bass", name: "Sub" });

  relay.down = false;
  await vi.waitFor(() => expect(bob.history().project.tempo).toBe(90));
  await vi.waitFor(() => expect(alice.history().project.tracks[1]!.name).toBe("Sub"));
  expect(alice.history().project).toEqual(bob.history().project);
  expect(status(alice)).toBe("live");
  // Bob kept the Project he had taken: it wasn't sent again.
  expect(bob.adopted).toHaveLength(1);
});

test("a copy of the same Shared Project joins with what it has, and keeps its history and undo", async () => {
  const relay = new FakeRelay();
  const invite = newInvite("wss://relay.test");
  const aliceHistory = new ProjectHistory(sampleProject(), { copy: "alice", by: "Alice" });
  aliceHistory.execute({ type: "setTempo", tempo: 100 });
  // Bob opened the shared folder: the base as it was written, and Alice's Change.
  const read = parseProject(serialiseProject(aliceHistory.base));
  if (!read.ok) throw new Error(read.error);
  const bobHistory = new ProjectHistory(read.project, { copy: "bob", by: "Bob", changes: aliceHistory.log });
  bobHistory.execute({ type: "renameTrack", trackId: "keys", name: "Piano" });

  const alice = join(relay, invite, aliceHistory, false);
  const bob = join(relay, invite, bobHistory, true);
  await vi.waitFor(() => expect(status(bob)).toBe("live"));
  await vi.waitFor(() => expect(alice.history().project.tracks[0]!.name).toBe("Piano"));
  expect(bob.adopted).toHaveLength(0);
  expect(bob.history()).toBe(bobHistory);
  expect(bobHistory.undo()).toBe(true);
  await vi.waitFor(() => expect(alice.history().project.tracks[0]!.name).toBe("Keys"));
  expect(alice.history().project.tempo).toBe(100);
});

test("audio the Project names is passed on to whoever lacks it, in as many parts as it takes", async () => {
  const relay = new FakeRelay();
  const invite = newInvite("wss://relay.test");
  const project = sampleProject();
  const vocal = createAudioTrack("Take", "take");
  vocal.clips.push({ id: "take-clip", kind: "audio", start: 0, duration: 1, file: "audio/take-1.wav", fileOffset: 0 });
  project.tracks.push(vocal);
  const bytes = Array.from({ length: PART * 2 + 17 }, (_, index) => index % 256);
  const samples: LoadedSamples = new Map([["audio/take-1.wav", { name: "take-1.wav", bytes }]]);

  join(relay, invite, new ProjectHistory(project, { copy: "alice" }), false, { samples });
  const bob = join(relay, invite, new ProjectHistory(createProject("Untitled")), true);
  await vi.waitFor(() => expect(bob.samples.has("audio/take-1.wav")).toBe(true));
  const passed = bob.samples.get("audio/take-1.wav")!;
  expect(passed.name).toBe("take-1.wav");
  // `toEqual` takes seconds over a megabyte.
  expect(passed.bytes.length === bytes.length && passed.bytes.every((byte, index) => byte === bytes[index])).toBe(true);
  expect(relay.seen.length).toBeGreaterThan(3);
});

test("someone with the wrong key sees nothing of the session, and whoever joins alone waits for its Project", async () => {
  const relay = new FakeRelay();
  const invite = newInvite("wss://relay.test");
  const { alice } = await aliceAndBob(relay, invite);
  const eve = join(relay, { ...newInvite(invite.relay), session: invite.session }, new ProjectHistory(createProject("Mine")), true);
  await vi.waitFor(() => expect(status(eve)).toBe("waiting"));
  run(alice, { type: "setTempo", tempo: 90 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(status(eve)).toBe("waiting");
  expect(eve.adopted).toHaveLength(0);
  expect(eve.history().project.name).toBe("Mine");
  expect(alice.members).toEqual(["Bob"]);
});

test("whoever leaves is gone from the others' list, and doesn't come back", async () => {
  const { alice, bob } = await aliceAndBob();
  await vi.waitFor(() => expect(alice.members).toEqual(["Bob"]));
  bob.session.leave();
  expect(status(bob)).toBe("left");
  await vi.waitFor(() => expect(alice.members).toEqual([]));
  run(bob, { type: "setTempo", tempo: 60 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(alice.history().project.tempo).toBe(120);
});

test("a session's Project from another version of Soundcheck says both need the same one, and isn't taken", async () => {
  const relay = new FakeRelay();
  const invite = newInvite("wss://relay.test");
  const bob = join(relay, invite, new ProjectHistory(createProject("Untitled")), true);
  await vi.waitFor(() => expect(status(bob)).toBe("waiting"));

  // A member on an older Soundcheck, as the wire carries it.
  const key = await importKey(invite);
  const old = relay.connect(`${invite.relay}/session/${invite.session}`);
  await new Promise<void>((resolve) => old.addEventListener("open", resolve));
  const message = encodeMessage({
    type: "project",
    base: "old",
    sync: "1.0",
    project: serialiseProject(sampleProject()),
    changes: [],
  });
  for (const frame of split(message)) old.send((await seal(key, frame)) as Uint8Array<ArrayBuffer>);
  await vi.waitFor(() => expect(status(bob)).toBe("update"));
  expect(bob.adopted).toHaveLength(0);
  expect(SYNC_VERSION).not.toBe("1.0");
  old.close();
});
