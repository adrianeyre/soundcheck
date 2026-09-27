/**
 * A Live Session (ADR 0007): this copy of the Project, and the other
 * members', passing each Change through a Relay as it is made.
 *
 * Nothing is kept at the Relay, so the members bring each other up to date.
 * Whoever connects says hello with what they have, and everyone who hears it
 * sends what they lack and says hello back, so they send what the others
 * lack. Someone joining without the session's Project, such as the Browser
 * Version opening an invite link, is sent it by whoever has it: its base and
 * every Change since. Audio a Change names is asked for and passed on too.
 *
 * Everything goes through the Relay sealed with the session's key
 * (`live-wire.ts`), which only the invite link holds.
 */
import { type Change, SYNC_VERSION } from "../project/change";
import type { LoadedSamples } from "../project/engine-sync";
import { ProjectHistory } from "../project/history";
import { parseProject, serialiseProject } from "../project/serialise";
import { audioFiles } from "../storage/project-folder";
import {
  type Audio,
  baseId,
  decodeMessage,
  encodeMessage,
  type Envelope,
  type Hello,
  importKey,
  type Invite,
  type LiveMessage,
  MESSAGE_LIMIT,
  type ProjectMessage,
  Reassembly,
  seal,
  sessionUrl,
  split,
  unseal,
} from "./live-wire";
import { isChange } from "./shared-folder";

/** What a Live Session needs of a WebSocket; tests give it one of their own. */
export interface LiveSocket {
  binaryType: string;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
}

export type LiveStatus =
  | { kind: "connecting" }
  /** Joining, and nobody in the session has sent its Project yet. */
  | { kind: "waiting" }
  | { kind: "live" }
  | { kind: "reconnecting"; reason: string }
  /** Joining, and the session's Project is from a version of Soundcheck this one can't apply. */
  | { kind: "update"; reason: string }
  | { kind: "left" };

export interface LiveSessionOptions {
  invite: Invite;
  history: ProjectHistory;
  /**
   * Joining a session someone else started: its Project is taken in place of
   * this one, unless this one is it already (the same Shared Project).
   * Starting one: this Project is the session's.
   */
  joining: boolean;
  /** The audio the Project has loaded, by path, to pass to members who ask. */
  samples: () => LoadedSamples;
  /** Audio a member passed on, which this copy's Project names. */
  onAudio: (samples: LoadedSamples) => void;
  /** The session's Project, taken when joining: a new history, which the session follows from then on. */
  onProject?: (history: ProjectHistory) => void;
  onStatus?: (status: LiveStatus) => void;
  /** Who else is in the session now, by name. */
  onMembers?: (names: string[]) => void;
  /** Which copy this is, if the session's Project is taken: kept from one visit to the next. The history's own otherwise. */
  copy?: string;
  connect?: (url: string) => LiveSocket;
  /** How long to wait before connecting again, by how many times it has failed. */
  retryAfter?: (attempt: number) => number;
}

/** A file asked for isn't asked for again, or given again, for this long. */
const ASK_AGAIN_MS = 30_000;
/** How many Changes go in one message, at most. */
const BATCH = 1000;

function wait(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

export class LiveSession {
  readonly #options: LiveSessionOptions;
  readonly #key: Promise<CryptoKey>;
  #history: ProjectHistory;
  #unsubscribe: () => void = () => {};
  #joining: boolean;
  #socket: LiveSocket | null = null;
  #open = false;
  #left = false;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Frames are sealed and sent in order, and so taken in. */
  #sending: Promise<void> = Promise.resolve();
  #receiving: Promise<void> = Promise.resolve();
  #reassembly = new Reassembly();
  /** Everyone else in the session, by copy, and their names. */
  readonly #members = new Map<string, string | undefined>();
  readonly #asked = new Map<string, number>();
  readonly #given = new Map<string, number>();
  /** The id of the history's base, once worked out, or as the session's Project said. */
  #base: { of: ProjectHistory; id: Promise<string> } | null = null;

  constructor(options: LiveSessionOptions) {
    this.#options = options;
    this.#key = importKey(options.invite);
    this.#history = options.history;
    this.#joining = options.joining;
    this.#follow(options.history);
    this.#connect();
  }

  /** The history the session keeps in step: the session's own, once a joiner has taken it. */
  get history(): ProjectHistory {
    return this.#history;
  }

  /** Leave the session: the others are told, and it doesn't reconnect. */
  leave(): void {
    if (this.#left) return;
    this.#send({ type: "bye", copy: this.#history.copy });
    this.#left = true;
    this.#unsubscribe();
    if (this.#timer !== null) clearTimeout(this.#timer);
    const socket = this.#socket;
    void this.#sending.then(() => socket?.close(1000, "Left the session"));
    this.#status({ kind: "left" });
  }

  #follow(history: ProjectHistory) {
    this.#unsubscribe();
    this.#history = history;
    // A joiner's edits before it has the session's Project are to its own.
    this.#unsubscribe = history.onChange((change) => {
      if (!this.#joining) this.#send({ type: "changes", changes: [change] });
    });
  }

  #status(status: LiveStatus) {
    this.#options.onStatus?.(status);
  }

  #connect() {
    this.#timer = null;
    this.#status({ kind: "connecting" });
    const connect = this.#options.connect ?? ((url) => new WebSocket(url));
    let socket: LiveSocket;
    try {
      socket = connect(sessionUrl(this.#options.invite));
    } catch (reason) {
      this.#retry(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (this.#socket !== socket) return;
      this.#open = true;
      this.#attempt = 0;
      this.#status({ kind: this.#joining ? "waiting" : "live" });
      void this.#hello(true);
      this.#askForAudio();
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket === socket && event.data instanceof ArrayBuffer) this.#receive(new Uint8Array(event.data));
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#open = false;
      this.#members.clear();
      this.#options.onMembers?.([]);
      if (!this.#left) this.#retry(event.reason || "The connection to the Relay was lost.");
    });
  }

  #retry(reason: string) {
    if (this.#left) return;
    this.#status({ kind: "reconnecting", reason });
    this.#timer = setTimeout(() => this.#connect(), (this.#options.retryAfter ?? wait)(this.#attempt));
    this.#attempt += 1;
  }

  #send(message: LiveMessage, bytes?: Uint8Array) {
    const socket = this.#socket;
    if (!socket || !this.#open || this.#left) return;
    const frames = split(encodeMessage(message, bytes));
    this.#sending = this.#sending
      .then(async () => {
        const key = await this.#key;
        for (const frame of frames) {
          const sealed = await seal(key, frame);
          if (this.#socket !== socket) return;
          socket.send(sealed as Uint8Array<ArrayBuffer>);
        }
      })
      .catch(() => {
        // The connection went: whatever didn't go is caught up on reconnecting.
      });
  }

  #receive(frame: Uint8Array) {
    this.#receiving = this.#receiving
      .then(async () => {
        const plain = await unseal(await this.#key, frame);
        const whole = plain && this.#reassembly.add(plain);
        const envelope = whole && decodeMessage(whole);
        if (envelope) await this.#handle(envelope);
      })
      .catch(() => {
        // One message that can't be taken in doesn't stop the rest.
      });
  }

  #baseId(): Promise<string> {
    if (this.#base?.of !== this.#history) this.#base = { of: this.#history, id: baseId(this.#history.base) };
    return this.#base.id;
  }

  async #hello(answer: boolean) {
    this.#sendHello(await this.#baseId(), answer);
  }

  #sendHello(base: string, answer: boolean) {
    const history = this.#history;
    this.#send({
      type: "hello",
      copy: history.copy,
      ...(history.by ? { by: history.by } : {}),
      base,
      sync: SYNC_VERSION,
      have: history.have,
      answer,
    });
  }

  async #handle({ message, bytes }: Envelope) {
    switch (message.type) {
      case "hello":
        return this.#heard(message);
      case "changes":
        // A joiner's own Project may not be the session's until it is sent it.
        if (!this.#joining && Array.isArray(message.changes)) {
          this.#history.receive(message.changes.filter(isChange));
          this.#askForAudio();
        }
        return;
      case "project":
        return this.#take(message);
      case "want":
        if (Array.isArray(message.files)) this.#give(message.files.filter((file) => typeof file === "string"));
        return;
      case "audio":
        return this.#takeAudio(message, bytes);
      case "bye":
        this.#members.delete(message.copy);
        this.#tellMembers();
        return;
    }
  }

  async #heard(hello: Hello) {
    if (typeof hello.copy !== "string" || typeof hello.base !== "string" || typeof hello.have !== "object" || !hello.have) return;
    this.#members.set(hello.copy, typeof hello.by === "string" ? hello.by : undefined);
    this.#tellMembers();
    const base = await this.#baseId();
    if (hello.base === base) {
      if (this.#joining) {
        // This copy has the session's Project already: a Shared Project's.
        this.#joining = false;
        this.#status({ kind: "live" });
        this.#askForAudio();
      }
      // Hello first, so a member still joining knows to take the Changes after it.
      if (hello.answer) this.#sendHello(base, false);
      const missing = this.#history.log.filter((change) => change.seq > (hello.have[change.copy] ?? 0));
      for (let at = 0; at < missing.length; at += BATCH) this.#send({ type: "changes", changes: missing.slice(at, at + BATCH) });
      return;
    }
    if (hello.answer) this.#sendHello(base, false);
    if (!this.#joining) {
      this.#send({
        type: "project",
        base,
        sync: SYNC_VERSION,
        project: serialiseProject(this.#history.base),
        changes: [...this.#history.log],
      });
    }
  }

  /** The session's Project, if this copy is joining and hasn't got it. */
  async #take(message: ProjectMessage) {
    if (!this.#joining || typeof message.base !== "string") return;
    if (message.sync !== SYNC_VERSION) {
      this.#status({
        kind: "update",
        reason: "Someone in this Live Session is using another version of Soundcheck. Both of you need the latest to edit together.",
      });
      return;
    }
    const parsed = typeof message.project === "string" ? parseProject(message.project) : null;
    if (!parsed?.ok || !Array.isArray(message.changes)) return;
    const changes: Change[] = message.changes.filter(isChange);
    // The same copy as said hello, so the others see one member.
    const copy = this.#options.copy ?? this.#history.copy;
    const history = new ProjectHistory(parsed.project, { copy, by: this.#history.by, changes });
    this.#joining = false;
    this.#follow(history);
    // Its base is the session's, however this copy would have written it.
    this.#base = { of: history, id: Promise.resolve(message.base) };
    this.#options.onProject?.(history);
    this.#status({ kind: "live" });
    // What was made while it was on its way.
    await this.#hello(false);
    this.#askForAudio();
  }

  #tellMembers() {
    this.#options.onMembers?.([...this.#members.values()].map((name) => name ?? "Someone"));
  }

  /** Ask the session for the audio the Project names that isn't here. */
  #askForAudio() {
    if (this.#joining) return;
    const have = this.#options.samples();
    const now = Date.now();
    const files = audioFiles(this.#history.project).filter(
      (file) => !have.has(file) && now - (this.#asked.get(file) ?? -Infinity) > ASK_AGAIN_MS,
    );
    if (files.length === 0) return;
    for (const file of files) this.#asked.set(file, now);
    this.#send({ type: "want", files });
  }

  #give(files: string[]) {
    const samples = this.#options.samples();
    const now = Date.now();
    for (const file of files) {
      const sample = samples.get(file);
      // Larger audio comes through the folder instead.
      if (!sample || sample.bytes.length > MESSAGE_LIMIT - PADDING) continue;
      if (now - (this.#given.get(file) ?? -Infinity) < ASK_AGAIN_MS) continue;
      this.#given.set(file, now);
      this.#send({ type: "audio", file, name: sample.name }, Uint8Array.from(sample.bytes));
    }
  }

  #takeAudio(message: Audio, bytes: Uint8Array) {
    const { file, name } = message;
    if (typeof file !== "string" || typeof name !== "string" || this.#options.samples().has(file)) return;
    if (!audioFiles(this.#history.project).includes(file)) return;
    this.#asked.delete(file);
    this.#options.onAudio(new Map([[file, { name, bytes: [...bytes] }]]));
  }
}

/** Room in a message for what comes with an audio file. */
const PADDING = 4096;
