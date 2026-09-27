import { expect, test } from "vitest";

import { sampleProject } from "../project/fixtures";
import { parseProject, serialiseProject } from "../project/serialise";
import {
  baseId,
  decodeMessage,
  encodeMessage,
  FRAME_LIMIT,
  importKey,
  inviteLink,
  MESSAGE_LIMIT,
  newInvite,
  PART,
  Reassembly,
  readInvite,
  relayAddress,
  seal,
  sessionUrl,
  split,
  unseal,
} from "./live-wire";

test("an invite link carries the Relay, the session and its key in the part of the address no server is sent", () => {
  const invite = newInvite("wss://relay.example.com");
  const link = inviteLink(invite, "https://example.github.io/soundcheck/#settings");
  expect(link.startsWith("https://example.github.io/soundcheck/#live=")).toBe(true);
  expect(readInvite(link)).toEqual(invite);
  // Or just what is after the `#`, as the Browser Version reads it.
  expect(readInvite(link.slice(link.indexOf("#") + 1))).toEqual(invite);
  expect(sessionUrl(invite)).toBe(`wss://relay.example.com/session/${invite.session}`);
  // Each session is new.
  expect(newInvite("wss://relay.example.com").key).not.toBe(invite.key);
});

const make = (value: unknown) => `#live=${btoa(JSON.stringify(value)).replaceAll("=", "")}`;

test("anything else is not an invite", () => {
  const good = newInvite("wss://relay.example.com");
  expect(readInvite("https://example.com/")).toBeNull();
  expect(readInvite("#live=not base64!")).toBeNull();
  expect(readInvite(make({ relay: good.relay }))).toBeNull();
  expect(readInvite(make(["ftp://relay.example.com", good.session, good.key]))).toBeNull();
  expect(readInvite(make([good.relay, "short", good.key]))).toBeNull();
  expect(readInvite(make([good.relay, good.session, "c2hvcnQ"]))).toBeNull();
});

test("a Relay's address is taken as a WebSocket's however it is typed", () => {
  expect(relayAddress("relay.example.com")).toBe("wss://relay.example.com");
  expect(relayAddress(" https://relay.example.com/ ")).toBe("wss://relay.example.com");
  expect(relayAddress("http://192.168.1.20:8080")).toBe("ws://192.168.1.20:8080");
  expect(relayAddress("wss://relay.example.com/soundcheck")).toBe("wss://relay.example.com/soundcheck");
  expect(relayAddress("")).toBeNull();
  expect(relayAddress("ftp://relay.example.com")).toBeNull();
  expect(relayAddress("wss://")).toBeNull();
});

test("only the session's key opens what it sealed, and nothing changed on the way is taken", async () => {
  const key = await importKey(newInvite("wss://relay.example.com"));
  const other = await importKey(newInvite("wss://relay.example.com"));
  const plain = new TextEncoder().encode("a Change");
  const frame = await seal(key, plain);
  expect(new TextDecoder().decode(frame)).not.toContain("a Change");
  expect(await unseal(key, frame)).toEqual(plain);
  // The same message sealed twice looks different.
  expect(await seal(key, plain)).not.toEqual(frame);
  expect(await unseal(other, frame)).toBeNull();
  const tampered = frame.slice();
  tampered[20]! ^= 1;
  expect(await unseal(key, tampered)).toBeNull();
  expect(await unseal(key, new Uint8Array(4))).toBeNull();
});

test("a message and the bytes that come with it are read back as they were sent", () => {
  const bytes = Uint8Array.from([1, 2, 3]);
  const encoded = encodeMessage({ type: "audio", file: "audio/take.wav", name: "take.wav" }, bytes);
  expect(decodeMessage(encoded)).toEqual({ message: { type: "audio", file: "audio/take.wav", name: "take.wav" }, bytes });
  expect(decodeMessage(encodeMessage({ type: "bye", copy: "alice" }))?.bytes).toHaveLength(0);
  expect(decodeMessage(new TextEncoder().encode("junk"))).toBeNull();
  const unknown = new TextEncoder().encode(`....{"type":"shout"}`);
  new DataView(unknown.buffer).setUint32(0, unknown.length - 4);
  expect(decodeMessage(unknown)).toBeNull();
});

/** Whether two byte arrays hold the same bytes; `toEqual` takes seconds over a megabyte. */
function same(a: Uint8Array | null, b: Uint8Array): boolean {
  return a !== null && a.length === b.length && a.every((byte, index) => byte === b[index]);
}

test("a large message goes in parts no larger than the Relay takes, and comes back together between others'", async () => {
  const key = await importKey(newInvite("wss://relay.example.com"));
  const large = Uint8Array.from({ length: PART * 2 + 100 }, (_, index) => (index * 7) % 256);
  const other = Uint8Array.from({ length: PART + 5 }, (_, index) => index % 251);
  const parts = split(large);
  expect(parts).toHaveLength(3);
  for (const part of parts) expect((await seal(key, part)).length).toBeLessThanOrEqual(FRAME_LIMIT);

  const reassembly = new Reassembly();
  const [a, b] = [parts, split(other)];
  expect(reassembly.add(a[0]!)).toBeNull();
  expect(reassembly.add(b[1]!)).toBeNull();
  expect(reassembly.add(a[2]!)).toBeNull();
  expect(same(reassembly.add(b[0]!), other)).toBe(true);
  expect(same(reassembly.add(a[1]!), large)).toBe(true);
  // A small one needs no putting together.
  expect(reassembly.add(split(Uint8Array.from([9]))[0]!)).toEqual(Uint8Array.from([9]));
});

test("a message larger than a member takes, or one that stops arriving, is let go", () => {
  let now = 0;
  const reassembly = new Reassembly(1000, () => now);
  const big = split(new Uint8Array(3000), 500);
  for (const part of big) expect(reassembly.add(part)).toBeNull();

  const slow = split(Uint8Array.from({ length: 900 }, () => 1), 500);
  expect(reassembly.add(slow[0]!)).toBeNull();
  now += 121_000;
  expect(reassembly.add(split(new Uint8Array(900), 500)[0]!)).toBeNull();
  // The rest of the first comes too late for it.
  expect(reassembly.add(slow[1]!)).toBeNull();
  expect(MESSAGE_LIMIT).toBeGreaterThan(FRAME_LIMIT);
});

test("a Project's base id is the same however its keys are ordered, as it was written or read back", async () => {
  const project = sampleProject();
  const read = parseProject(serialiseProject(project));
  if (!read.ok) throw new Error(read.error);
  const shuffled = Object.fromEntries(Object.entries(project).toReversed()) as typeof project;
  expect(await baseId(read.project)).toBe(await baseId(project));
  expect(await baseId(shuffled)).toBe(await baseId(project));
  expect(await baseId({ ...project, tempo: project.tempo + 1 })).not.toBe(await baseId(project));
});
