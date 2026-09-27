/**
 * What a Live Session sends through its Relay (ADR 0007), and how: invite
 * links, the encryption only the members hold the key to, and messages
 * split into frames the Relay will take.
 *
 * Every frame is sealed with AES-GCM under the session's key, with a fresh
 * random 12-byte IV at its start, so the Relay sees only sizes and timing.
 * Inside, a frame is a whole message, or one part of a larger one:
 *
 *     whole: 0, then the message
 *     part:  1, an 8-byte id, the part's index and the count of parts (each
 *            a big-endian u32), then that part of the message
 *
 * and a message is the length of its JSON (a big-endian u32), the JSON, and
 * any bytes that come with it, such as an audio file's.
 */
import type { Change } from "../project/change";
import type { Project } from "../project/model";

/** A Live Session, as its invite link carries it. */
export interface Invite {
  /** The Relay's address: `wss://…`, or `ws://…` for one on this network. */
  relay: string;
  /** Random, and the session's name at the Relay. */
  session: string;
  /** The session's AES-GCM key, base64url: never sent to the Relay. */
  key: string;
}

/** What each member tells the rest as they connect: who they are, and what they have. */
export interface Hello {
  type: "hello";
  copy: string;
  by?: string;
  /** Which Project the Changes start from, so two copies know they are the same one. */
  base: string;
  /** The rules this copy applies Changes by. */
  sync: string;
  /** The latest of each copy's Changes this one has, by copy. */
  have: Record<string, number>;
  /** Whether each member hearing it should say hello back, so it learns what they have. */
  answer: boolean;
}

export interface Changes {
  type: "changes";
  changes: Change[];
}

/** The session's Project, for a member joining without it: its base and every Change since. */
export interface ProjectMessage {
  type: "project";
  base: string;
  sync: string;
  /** The base, as `serialiseProject` writes it, so it is migrated and checked as a file would be. */
  project: string;
  changes: Change[];
}

/** Audio a member's Project names that they haven't got. */
export interface Want {
  type: "want";
  files: string[];
}

/** An audio file, whose bytes come with the message. */
export interface Audio {
  type: "audio";
  file: string;
  name: string;
}

/** A member is leaving. */
export interface Bye {
  type: "bye";
  copy: string;
}

export type LiveMessage = Hello | Changes | ProjectMessage | Want | Audio | Bye;

/** A message, and the bytes that come with it. */
export interface Envelope {
  message: LiveMessage;
  bytes: Uint8Array;
}

/** The largest frame the Relay takes (`relay/src/lib.rs`). */
export const FRAME_LIMIT = 1024 * 1024;
/** How much of a message goes in one frame: well under the limit, with the IV, tag and header. */
export const PART = 512 * 1024;
/** The largest message a member takes: audio larger than this comes through the folder instead. */
export const MESSAGE_LIMIT = 64 * 1024 * 1024;
const IV = 12;

const LINK_PREFIX = "live=";

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * The Relay's address as a WebSocket's, from what someone typed: `https://`
 * is taken as `wss://`, and a bare host as `wss://` too. Null if it isn't one.
 */
export function relayAddress(typed: string): string | null {
  const text = typed.trim();
  if (text === "") return null;
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `wss://${text}`;
  try {
    const url = new URL(withScheme.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:"));
    if ((url.protocol !== "wss:" && url.protocol !== "ws:") || url.hostname === "") return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

const random = (length: number) => base64url(crypto.getRandomValues(new Uint8Array(length)));

/** A new Live Session on `relay`: a random id, and a random key. */
export function newInvite(relay: string): Invite {
  return { relay, session: random(16), key: random(32) };
}

/**
 * The link that invites someone into the session: `site`, the Browser
 * Version's address, with the session in the `#`, which browsers never send
 * to a server.
 */
export function inviteLink(invite: Invite, site: string): string {
  const fragment = base64url(new TextEncoder().encode(JSON.stringify([invite.relay, invite.session, invite.key])));
  return `${site.replace(/#.*$/, "")}#${LINK_PREFIX}${fragment}`;
}

/** The session an invite link, or just its `#live=…`, is for; null if it isn't one. */
export function readInvite(link: string): Invite | null {
  const at = link.trim().indexOf(LINK_PREFIX);
  if (at < 0) return null;
  const bytes = fromBase64url(link.trim().slice(at + LINK_PREFIX.length));
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(value) || value.length !== 3 || !value.every((each) => typeof each === "string")) return null;
    const [typed, session, key] = value as [string, string, string];
    const relay = relayAddress(typed);
    const raw = fromBase64url(key);
    if (!relay || !/^[A-Za-z0-9_-]{16,64}$/.test(session) || raw?.length !== 32) return null;
    return { relay, session, key };
  } catch {
    return null;
  }
}

/** Where the session is at its Relay. */
export function sessionUrl(invite: Invite): string {
  return `${invite.relay}/session/${invite.session}`;
}

export function importKey(invite: Invite): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64url(invite.key)! as Uint8Array<ArrayBuffer>, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** A frame sealed with the session's key, its random IV first. */
export async function seal(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain as Uint8Array<ArrayBuffer>));
  const frame = new Uint8Array(IV + sealed.length);
  frame.set(iv);
  frame.set(sealed, IV);
  return frame;
}

/** What a frame holds, or null if it wasn't sealed with this key or was changed on the way. */
export async function unseal(key: CryptoKey, frame: Uint8Array): Promise<Uint8Array | null> {
  if (frame.length < IV) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: frame.subarray(0, IV) as Uint8Array<ArrayBuffer> },
      key,
      frame.subarray(IV) as Uint8Array<ArrayBuffer>,
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

export function encodeMessage(message: LiveMessage, bytes: Uint8Array = new Uint8Array()): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message));
  const encoded = new Uint8Array(4 + json.length + bytes.length);
  new DataView(encoded.buffer).setUint32(0, json.length);
  encoded.set(json, 4);
  encoded.set(bytes, 4 + json.length);
  return encoded;
}

const TYPES: ReadonlySet<unknown> = new Set(["hello", "changes", "project", "want", "audio", "bye"]);

/** The message `encodeMessage` made, or null if these bytes aren't one. What is in it is checked where it is used. */
export function decodeMessage(encoded: Uint8Array): Envelope | null {
  if (encoded.length < 4) return null;
  const length = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).getUint32(0);
  if (4 + length > encoded.length) return null;
  try {
    const message: unknown = JSON.parse(new TextDecoder().decode(encoded.subarray(4, 4 + length)));
    if (typeof message !== "object" || message === null || !TYPES.has((message as { type?: unknown }).type)) return null;
    return { message: message as LiveMessage, bytes: encoded.slice(4 + length) };
  } catch {
    return null;
  }
}

const WHOLE = 0;
const PARTIAL = 1;
const PART_HEADER = 1 + 8 + 4 + 4;

/** A message as the frames it goes in, before each is sealed. */
export function split(message: Uint8Array, part = PART): Uint8Array[] {
  if (message.length + 1 <= part) {
    const frame = new Uint8Array(1 + message.length);
    frame[0] = WHOLE;
    frame.set(message, 1);
    return [frame];
  }
  const id = crypto.getRandomValues(new Uint8Array(8));
  const size = part - PART_HEADER;
  const count = Math.ceil(message.length / size);
  return Array.from({ length: count }, (_, index) => {
    const piece = message.subarray(index * size, (index + 1) * size);
    const frame = new Uint8Array(PART_HEADER + piece.length);
    const view = new DataView(frame.buffer);
    frame[0] = PARTIAL;
    frame.set(id, 1);
    view.setUint32(9, index);
    view.setUint32(13, count);
    frame.set(piece, PART_HEADER);
    return frame;
  });
}

interface Pending {
  parts: (Uint8Array | undefined)[];
  got: number;
  size: number;
  since: number;
}

/** How many messages may be arriving at once, and for how long each may take. */
const ARRIVING = 16;
const ARRIVING_FOR_MS = 120_000;

/**
 * Puts messages back together from their frames, which the Relay passes on
 * in order from each member but interleaved between members. A message that
 * would be over `limit`, or doesn't finish arriving, is let go.
 */
export class Reassembly {
  readonly #pending = new Map<string, Pending>();
  readonly #limit: number;
  readonly #now: () => number;

  constructor(limit = MESSAGE_LIMIT, now: () => number = Date.now) {
    this.#limit = limit;
    this.#now = now;
  }

  /** The whole message this frame finishes, if it does. */
  add(frame: Uint8Array): Uint8Array | null {
    if (frame[0] === WHOLE) return frame.subarray(1);
    if (frame[0] !== PARTIAL || frame.length < PART_HEADER) return null;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const id = Array.from(frame.subarray(1, 9)).join(",");
    const index = view.getUint32(9);
    const count = view.getUint32(13);
    const piece = frame.subarray(PART_HEADER);
    this.#forgetOld();

    let pending = this.#pending.get(id);
    if (!pending) {
      if (count * piece.length > this.#limit + PART || count === 0) return null;
      while (this.#pending.size >= ARRIVING) this.#pending.delete(this.#pending.keys().next().value!);
      pending = { parts: Array.from<Uint8Array | undefined>({ length: count }), got: 0, size: 0, since: this.#now() };
      this.#pending.set(id, pending);
    }
    if (index >= pending.parts.length || pending.parts[index]) return null;
    pending.parts[index] = piece.slice();
    pending.got += 1;
    pending.size += piece.length;
    if (pending.size > this.#limit) {
      this.#pending.delete(id);
      return null;
    }
    if (pending.got < pending.parts.length) return null;

    this.#pending.delete(id);
    const whole = new Uint8Array(pending.size);
    let at = 0;
    for (const each of pending.parts) {
      whole.set(each!, at);
      at += each!.length;
    }
    return whole;
  }

  #forgetOld() {
    const now = this.#now();
    for (const [id, pending] of this.#pending) if (now - pending.since > ARRIVING_FOR_MS) this.#pending.delete(id);
  }
}

/**
 * Which Project a copy's Changes start from, the same on every copy that
 * has it: a hash of its JSON with every object's keys in order.
 */
export async function baseId(project: Project): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(project)));
  return base64url(new Uint8Array(digest).subarray(0, 16));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((each) => canonical(each === undefined ? null : each)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, each]) => each !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${canonical(each)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
