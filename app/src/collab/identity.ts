/**
 * Who this person is to their Collaborators, which copy of each Shared
 * Project is theirs, and which Relay their Live Sessions go through, kept on
 * this machine only: none of it is part of any Project.
 */
import { type LocalStore, localStore, readLocal, writeLocal } from "../settings/local-settings";
import type { ProjectFolder } from "../storage/file-storage";
import { relayAddress } from "./live-wire";

const NAME = "soundcheck.yourName";
const RELAY = "soundcheck.relay";
const copyKey = (folder: ProjectFolder) => `soundcheck.sharedCopy.${folder.id}`;
const liveCopyKey = (session: string) => `soundcheck.liveCopy.${session}`;

/** The name Collaborators see on this person's Changes, as Settings set it. */
export function yourName(store: LocalStore | null = localStore()): string | undefined {
  return readLocal(NAME, store)?.trim() || undefined;
}

export function setYourName(name: string, store: LocalStore | null = localStore()): void {
  writeLocal(NAME, name.trim(), store);
}

/**
 * This machine's copy of the Shared Project in `folder`, so its own Changes
 * go on in its own file from one session to the next; none where the folder
 * is new here. The browser names folders afresh each session, so there it
 * may be the copy used in another folder: harmless, as a copy's Changes go
 * on from the last of its own the folder holds.
 */
export function copyFor(folder: ProjectFolder, store: LocalStore | null = localStore()): string | undefined {
  return readLocal(copyKey(folder), store) ?? undefined;
}

export function rememberCopy(folder: ProjectFolder, copy: string, store: LocalStore | null = localStore()): void {
  writeLocal(copyKey(folder), copy, store);
}

/**
 * This machine's copy in the Live Session `session`, so rejoining it after
 * the app was closed goes on as the same copy, whose undo is still its own.
 */
export function liveCopyFor(session: string, store: LocalStore | null = localStore()): string | undefined {
  return readLocal(liveCopyKey(session), store) ?? undefined;
}

export function rememberLiveCopy(session: string, copy: string, store: LocalStore | null = localStore()): void {
  writeLocal(liveCopyKey(session), copy, store);
}

/** The Relay this person typed in Settings, as they typed it: empty for the one Soundcheck was built with. */
export function typedRelay(store: LocalStore | null = localStore()): string {
  return readLocal(RELAY, store) ?? "";
}

export function setTypedRelay(typed: string, store: LocalStore | null = localStore()): void {
  writeLocal(RELAY, typed.trim(), store);
}

/**
 * The Relay a new Live Session goes through: the one Settings names, or else
 * the one this build of Soundcheck was made with (`RELAY_URL`, ADR 0012).
 * Null if there is neither, or it isn't an address.
 */
export function relayFor(store: LocalStore | null = localStore(), built = import.meta.env.VITE_RELAY_URL ?? ""): string | null {
  const typed = typedRelay(store);
  return relayAddress(typed || built);
}
