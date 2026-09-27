import type { LiveSocket } from "./live-session";

/**
 * A Relay as the members see it, in memory: each frame one sends reaches
 * every other socket in the session, in order, and it can go down.
 */
export class FakeRelay {
  readonly sessions = new Map<string, Set<FakeSocket>>();
  /** Every frame it has passed on, as it saw them. */
  readonly seen: Uint8Array[] = [];
  down = false;

  connect = (url: string): LiveSocket => new FakeSocket(this, url);

  /** Every member's connection ends, as when the Relay restarts. */
  drop(): void {
    // Ending one takes it out of its session, so the list is taken first.
    for (const socket of Array.from(this.sessions.values(), (members) => Array.from(members)).flat()) {
      socket.end("The Relay restarted");
    }
  }
}

class FakeSocket implements LiveSocket {
  binaryType = "blob";
  readonly #listeners = new Map<string, ((event: MessageEvent & CloseEvent) => void)[]>();
  readonly #relay: FakeRelay;
  readonly #session: string;
  #open = false;

  constructor(relay: FakeRelay, url: string) {
    this.#relay = relay;
    this.#session = url.slice(url.lastIndexOf("/") + 1);
    setTimeout(() => {
      if (relay.down) return this.end("Couldn't reach the Relay");
      const members = relay.sessions.get(this.#session) ?? new Set();
      relay.sessions.set(this.#session, members.add(this));
      this.#open = true;
      this.#fire("open", {});
    });
  }

  send(data: Uint8Array<ArrayBuffer>): void {
    if (!this.#open) throw new Error("Not open");
    this.#relay.seen.push(data.slice());
    for (const other of this.#relay.sessions.get(this.#session) ?? []) {
      if (other === this) continue;
      const copy = data.slice().buffer;
      queueMicrotask(() => other.#deliver(copy));
    }
  }

  #deliver(data: ArrayBuffer) {
    if (this.#open) this.#fire("message", { data });
  }

  close(): void {
    this.end("");
  }

  end(reason: string): void {
    this.#open = false;
    this.#relay.sessions.get(this.#session)?.delete(this);
    setTimeout(() => this.#fire("close", { reason }));
  }

  addEventListener(type: string, listener: (event: MessageEvent & CloseEvent) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  #fire(type: string, event: Partial<MessageEvent & CloseEvent>) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event as MessageEvent & CloseEvent);
  }
}
