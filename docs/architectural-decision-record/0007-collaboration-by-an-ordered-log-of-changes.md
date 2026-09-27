# Collaboration: every copy of a Project applies one ordered log of Changes, and undo is a new Change

**Status: proposed** in the v4 pull request (#75), and **amended** as #76 built it: where the build differs from the design, [As #76 built it](#as-76-built-it) says how and why, and the sections it changes point there. The maintainer asked for the simplest model that lets several people edit one **Project**, live or by syncing later, and still lets each of them undo their own **Request** in one step. What the maintainer has to confirm is under [To confirm](#to-confirm).

## Why undo is the hard part

`ProjectHistory` (`app/src/project/history.ts`) keeps each undo step as two whole Projects, the one before and the one after, and undo puts back the one before. With one person, that is exact and simple. With two, it is wrong: if Sam renames a Track after your Request, undoing your Request puts back the Project from before it and wipes out Sam's rename. The same reason is why a Request holds the history `BUSY` today: a change made by anyone in the middle of a group could only be undone with it or not at all.

So collaboration needs undo that removes **what your step did**, not **everything since**. That decision constrains the rest.

## Decision

### A step is a Change: values written, keyed by id

Each undo step (one command, or everything one Request did) becomes a **Change**: a list of writes, each of the form `key: from → to`, over a flat form of the Project.

- **The flat form.** Everything with an identity is an *item*: Tracks, Buses, Clips, Effects (in any Insert Chain, the Master's included), Sections and Tempo Changes by their `id`; a Send by the Bus it feeds; an Automation by its setting. An item is one entry saying which list of which owner it is in, plus one entry per field, keyed by the item's id and never by its position. So a Clip moved to another Track is still the same Clip, and an edit to it follows it. Each list's order is one more entry. Nested objects (a mixer, a Synth's settings, a time signature) are flattened field by field. Any other array is a single value: a Pattern Clip's notes, an Automation's breakpoints, a Drum Sampler's Pads.
- **Diffing** a command's before and after Projects gives its writes. Projects are never changed in place, so the diff skips every part of the tree that is still the same object and only looks at what the command touched.
- A **Request** stays one step: every command it runs adds to one Change, which is sent when the Request ends. Changes that arrive from others while it runs are applied around it and are never part of it. A **Suggestion** that is applied is one Change, as it is one step today.

### Every copy puts the Changes in one order

In a **Shared Project**, each person has their own copy. Every Change carries a **Lamport clock**, higher than any clock its author had seen, and the id of the copy that made it. Every copy orders all the Changes it has by clock, then by copy id, and gets its Project by applying them in that order to the Project as it was when sharing began.

Applying is deterministic, so **two copies with the same Changes have the same Project**, whatever order the Changes arrived in and however late. That is the whole convergence argument, and it doesn't depend on how Changes travel. A Change that arrives out of order (Sam's week of offline edits) is slotted into its place and everything after it is applied again from the nearest checkpoint.

### Applying a Change: the last write wins, and the Project stays valid

- An **edit's** writes land whatever is there: where two people set the same value, the later one in the order wins.
- The Project must stay **valid** (`validate.ts`): two edits that are each fine can break a rule together, such as two Sends that between them make a loop, or two Sections that overlap. If a Change's writes would leave the Project invalid, it is applied item by item, keeping each item only if the Project stays valid, until no more can be kept, and the rest is refused. Every copy refuses the same writes. The author is told what was refused and why: *"Your Send to Reverb didn't stand: Sam had deleted the Bus."*
- Every Change carries the version of these rules it was made under (`SYNC_VERSION`, bumped whenever applying or validating changes meaning). A copy stops at the first Change in the order whose version isn't its own, applies nothing from there on, and says who needs to update Soundcheck. Otherwise two copies could apply the same Changes differently and never agree again.

### Undo is a new Change that only puts back what is still yours

Undoing your last step makes a new Change: the reverse of **what that step actually did** when it was applied, with every write **conditional**. It lands only where the value still holds what your step left.

- Where a **Collaborator** has since changed a value your step set, their value stays, and undo says so: *"Undo left the Bass volume: Sam changed it since."*
- An item your step added, which a Collaborator has since moved or changed, stays whole. An item is never half removed, and undo never removes someone else's work.
- Undoing your step brings back what it deleted, including anything a Collaborator added inside it at the same time (a Clip on a Track you deleted).
- If putting something back would break a rule, because a Collaborator deleted the Bus a Send you removed used to feed, the rest of the undo lands and that part is refused, as for any Change.
- **Redo** is the same, the other way. Your redo stack is cleared by your own edits, never by a Collaborator's.
- Undo and redo only ever reach your own steps. With nobody else editing, undo is exactly one step back, as it is today.
- `BUSY` stays for your own edits while your own Request runs, as today. It never holds back a Collaborator's Changes.

### How Changes travel: the Project folder offline, a Relay live

The log is the same whichever way it moves.

- **Offline, through the Project folder** (Desktop App). A Project is already a folder on disk. In a Shared Project each copy appends its own Changes to its own file, `changes/<copy id>.jsonl`, and `project.json` becomes the base the log starts from. The musicians' own file-sync service (OneDrive, Dropbox, iCloud Drive, Google Drive, Syncthing, or a Git repository) carries that folder, audio and all. Each file has one writer, so the sync service never has a conflicting copy to make. The Desktop App watches the folder and applies what arrives. This needs no server of ours.
- **Live, through a Relay.** Copies in a **Live Session** also send each Change to a **Relay** as soon as it is made, and the Relay passes it to everyone else in the session within a second. The Relay stores nothing. A copy that joins or reconnects catches up from the folder, or, in the **Browser Version** (which can't watch a folder), from the other members. Each member keeps a record of the highest clock it has from each copy, and sends a newcomer whatever it lacks.
- **Invites and privacy.** A Live Session's invite link carries the Relay address, a random session id and an encryption key in the link's `#` fragment, which browsers never send to a server. Changes and audio are encrypted with that key (AES-GCM, through WebCrypto on both platforms), so the Relay only sees session ids, sizes and timing, never a song. There are no accounts. Anyone with the folder or the link is a Collaborator, and taking someone out means sharing a new folder or starting a new session.
- **Audio.** Audio files are already never changed once written. In a Shared Project a new file's name also carries a hash of its content (`audio/Vocals take-3f9a2c1b.wav`), so two Collaborators recording at once never write different sounds to one path. The folder sync carries the audio. In a Live Session its encrypted bytes are also passed through the Relay, in chunks and up to a size limit, to whoever is connected. A Clip whose audio hasn't arrived yet shows it is waiting and plays silence.
*Amended by #76:* a Live Session isn't only for a Shared Project, the folder is read every 2 seconds rather than watched, catching up is by each copy's last Change rather than its clock, and compaction isn't built yet. See [As #76 built it](#as-76-built-it).

- **Compaction.** Each copy's file records the highest clock it has seen from each other copy. Once every Collaborator's file shows they have everything up to clock C, any copy may write the Project as it stood at C as the new base, and older Changes are no longer needed. Until then the log only grows; a Change is small, apart from edits to a Pattern Clip's notes, which carry the whole note list.

### Where the Relay lives, and who runs it

*Amended by #76:* [ADR 0012](0012-the-public-relay-runs-from-the-image-ci-publishes.md) (proposed) says how the Relay is published and leaves who runs it to the maintainer.

The Relay would be `relay/`, a small Rust program in this repository, tested in CI like the rest. It has sessions, WebSocket fan-out, a size limit and a rate limit, and no storage, no accounts and no way to read what it passes on. One binary or one container runs it.

- **The maintainer runs the default public Relay**, whose address the Desktop App and Browser Version start with. Because it stores nothing, its cost is bandwidth, mostly audio passed through in Live Sessions.
- **Anyone can run their own**, and a Relay address in Settings points Soundcheck at it: a studio, a band, or someone who doesn't want to trust ours.
- **With no Relay at all**, offline sync through the folder still works; only live editing needs one.

### Where it runs

*Amended by #76:* the Browser Version syncs a folder too, so nothing is listed as desktop-only. See [As #76 built it](#as-76-built-it).

The folder watcher and appender go behind a new interface in `app/src/platform.ts`. The desktop implementation comes first; the browser's is null, and `app/src/settings/desktop-only.ts` lists "Syncing a Shared Project's folder" as needing the Desktop App. The Relay client is WebSocket plus WebCrypto, so it runs in both, and the Browser Version can join a Live Session. None of it touches the **Audio Engine** ([ADR 0001](0001-audio-engine-in-rust.md)): Changes are Project data, which `engine-sync.ts` already turns into engine commands however the Project changed.

### The Assistant

A Request is sent the **Project Summary** at its start, as today. If a Collaborator deletes something mid-Request, the Assistant's next tool call on it is refused with the usual error, and the Assistant carries on from there. What it did is one Change and one undo step, and undoing it follows the rules above.

## As #76 built it

#76 built slices 1 to 4 of [How #76 builds it](#how-76-builds-it) as designed, except where this section says otherwise. Slice 5, compaction, isn't built.

### Changes and undo

- **The flat form and the diff** are `app/src/project/flat.ts` and `change.ts`, as designed. Commands' results reuse every object of the Project they didn't change, so the diff only walks what a command touched.
- **Item by item, with lists.** When a Change is applied item by item, a list's order entry goes in one group with the items it puts in or takes out. So no list ever names an item that was refused, and no list loses an item that stayed.
- **What undo leaves.** An undo leaves every write a Collaborator has overtaken. If it would remove an item, and any of that item's fields has been overtaken, it leaves the whole item. An item someone has changed since is never half taken away, and never taken away at all.
- **The version.** `SYNC_VERSION` is `1.<schema version>`, so any change to the Project format changes it too.

### The folder

- **Share this Project…** (the File menu) makes the open Project a Shared Project, in its folder or, before its first save, in one the musician picks. Schema 17 marks such a folder, so an older Soundcheck, which would read the base alone, refuses to open it.
- **Read every 2 seconds, not watched.** Each copy reads the new bytes of every `changes/*.jsonl` file, from where it last stopped. A file-sync service's own watchers and filesystem events differ too much between OneDrive, Dropbox and a network share, and a 2-second poll of a few small files costs nothing noticeable.
- **The Browser Version syncs a folder too.** Chrome and Edge append and read through the File System Access API, which was cheap to add. It is behind the same `FileStorage` interface as the desktop's two new Rust commands. So it isn't listed in `desktop-only.ts`: a browser without Project folders lacks it along with them.
- **Audio names.** New audio in a Shared Project is named with 12 hex digits of a hash of its bytes (two seeded FNV-1a hashes), which is enough to keep two people's `kick.wav` apart. It isn't meant to stop anyone forging a collision.
- **A VST3 Plugin's state** lives in its instance ([ADR 0008](0008-vst3-plugins-run-in-a-helper-process.md)), so in a Shared Project it becomes a Change when the musician saves, as it joins the Project on saving anywhere else.

### Live Sessions

- **Any Project, not only a Shared one.** *File → Live Session…* starts one with the Project that is open. A Shared Project's copies join with the base their folder already has. Any other Project starts a new log from the Project as it is, and whoever joins is sent it. A Live Session needs no folder, so the Browser Version in Firefox can take part too.
- **The invite link** is `<site>#live=<base64url of [Relay address, session id, key]>`. The session id is 16 random bytes and the key is 32. `<site>` is the Browser Version: its own address there, or `VITE_SITE_URL` built into the Desktop App, which is the address the web build's share tags use too. The Desktop App joins from the same link, pasted into Join. The Browser Version, opened from a link, starts with Join filled in and takes the fragment out of its address bar.
- **The wire** is `app/src/collab/live-wire.ts`.
  - Every frame is sealed with AES-GCM under the key, with a new random 12-byte IV.
  - A message is JSON, followed by any bytes it carries, such as audio.
  - A message over 1 MiB goes in 512 KiB parts. No message may be over 64 MiB.
  - The Relay only ever sees sealed binary frames and their sizes.
- **Joining.**
  - A member says who it is (`hello`): its copy, its name, its base (a hash of the base Project), its `SYNC_VERSION`, and the last Change it has from each copy.
  - A member with the same base answers with its own `hello`, then sends whatever the other lacks, in batches of 1000 Changes. The `hello` goes first so the joiner knows the base before any Change arrives.
  - A member with another base, which isn't still joining, sends its base and log (`project`).
  - A joiner takes the first Project it is sent on the same `SYNC_VERSION`, in place of its own. It asks before losing unsaved changes, and it keeps its copy id, so it isn't counted as two people. From then on it counts as not saved yet.
  - Until a joiner has taken the session's Project, or found it had the same one, its own edits aren't sent and others' Changes are ignored.
  - A Project from another `SYNC_VERSION` isn't taken, and the joiner is told both need the same Soundcheck.
- **Catching up by last Change, not clock.** Each copy numbers its own Changes 1, 2, 3…, and `have` is the highest it holds from each copy. That is exact as long as Changes from one copy arrive in order, which both ways of travelling keep. A copy that got some Changes through the folder and others live could in theory have a gap below its `have`. The next folder read fills that gap.
- **Reconnecting.** A dropped connection is tried again after 1, 2, 4… seconds, up to 30. Edits made meanwhile wait, and go with the catch-up. The Relay lets go of a member that can't keep up rather than buffer for it without end ([`relay/README.md`](../../relay/README.md)), and the member catches up the same way.
- **Audio.** A member asks (`want`) for the files the Project names that it hasn't loaded. Whoever has one sends it. A member asks for one file, and sends one file, at most once every 30 seconds. Audio waiting to arrive plays silence, and its Clip says *Waiting for its audio*, as designed; in a Project that isn't shared or live, a Clip whose file isn't there says its audio is missing. Every member that has a file answers a request for it, so with several members a file can be sent more than once. The 64 MiB message limit caps any single file.
- **Leaving** says so (`bye`), and the others' lists of who is there drop that member at once, not only when the connection times out.
- **Settings → Collaboration** has *Your name*, which your Changes carry, and *Relay address*, which overrides the one built in (`VITE_RELAY_URL`, from the repository variable `RELAY_URL`; [ADR 0012](0012-the-public-relay-runs-from-the-image-ci-publishes.md)). With neither, *Start a Live Session* says a Relay is needed and where to set it. Joining never needs one, as the link names it.

### Compaction isn't built

The log only grows. A Change is a few hundred bytes, apart from edits to a Pattern Clip's notes, and applying the log is fast (see [What the spike proved](#what-the-spike-proved)). So a Shared Project edited for months stays usable, and compaction can come once someone's log is big enough to matter. It needs one more thing in each copy's file: the last Change it has from every other copy. Then any copy can write a new base once every file shows it has everything up to that point.

### Where it was checked

Everything above is tested in `app/src/collab/` and `app/src/project/`, with two or three copies in one process. Copies are passed each other's Changes through a fake folder or a fake Relay. The Relay itself is tested over real WebSockets on this machine (`relay/tests/`). A fake Relay records every frame, and the tests check that no song name, Track name or command is in any of them. Nothing here was checked on two machines. The checks by hand are under [To confirm](#to-confirm).

## What the spike proved

[`spikes/collab-sync/`](../../spikes/collab-sync/README.md) implements the flat form, Changes, ordered application, item-by-item validation and conditional undo in about 500 lines of plain TypeScript, on a small Project in the app's shape with the rules two people's edits could break together. Its tests pass Changes between copies both live and as out-of-order, duplicated files. They show:

- Undoing a Request, including one that other people's Changes arrived in the middle of, undoes only that Request.
- With nobody else editing, undo is exactly one step back.
- Undo leaves values changed since, and says so.
- Undo brings back a deleted Bus and its Sends around others' edits, and refuses only the part a Collaborator's delete made impossible.
- Redo survives others' edits.
- Offline edits converge whatever order they arrive in.
- Two edits that break a rule together end with the same one refused everywhere.
- Tracks added at once are both kept, and an edit follows a Clip moved at the same time.

Randomised sessions of three people, 250 steps each, with partial and duplicated delivery, always converged to one valid Project on 300 seeds, and no undo ever changed anything outside the items it wrote to.

On this sandbox's VM, applying one arriving Change to a 515 KB Project (30 Tracks, 300 Pattern Clips) took about 0.8 ms, validation included. The spike's local edits were slow (23 ms) only because it diffs the whole Project each time, which the app won't do (see above).

## Alternatives considered

- **Lock the Project: one person edits at a time.** Keeps today's snapshot undo, but that isn't several people editing, and it can't work offline.
- **A server that orders and stores everything** (the Figma, Replicache or prosemirror-collab approach). Each client rebases its unconfirmed Changes onto the server's order, so no confirmed history is ever replayed, which is simpler on the client. But offline sync would need that server too. Soundcheck, which has no server today, would have to store musicians' unreleased songs and their audio, with accounts, backups and a bill that grows with every Project, and a Project would no longer be complete in its own folder. The ordered log gets the same convergence without any of that.
- **A CRDT library (Automerge, Yjs).** It converges on its own, and Yjs's `UndoManager` can undo only local changes. But no CRDT keeps this app's rules: a Bus never feeds itself, Sections never overlap, a channel has one Send per Bus. Two merged edits can break them, so the validate-and-refuse layer would be needed anyway, and it only converges if every copy applies it in one order, which is the ordered log again. Adopting one would also mean rewriting the Project as the library's types, and with it every command, `history.ts`, `engine-sync.ts` and every component that reads the Project, with the saved format becoming the library's. Automerge has no selective undo at all.
- **Operational transformation of commands.** With about 50 command types, every pair needs a transform function that keeps intent and the rules. That is far more code to get right than applying writes in one order.
- **Peer-to-peer (WebRTC) instead of a Relay.** It still needs a signalling server, and connections fail behind some routers and firewalls without a TURN server, which is a relay anyway. A plain Relay is simpler and works everywhere.

## Consequences

- **Undo changes for everyone, not only in Shared Projects.** `ProjectHistory` keeps Changes instead of whole Projects, and undo applies the conditional reverse. With one person the result is the same as today, and `history.test.ts` must pass unchanged. That is #76's first slice.
- **The Project format gains a shared form.** A Shared Project's folder has `changes/` beside `project.json`, which becomes the base. A folder never shared is unchanged. The schema version is bumped when #76 adds it.
- **The last write wins for single values**, so these are the limits of the first version:
  - Two people editing one Pattern Clip's notes at once: the later edit replaces the whole note list. The same goes for one Automation's breakpoints and one Drum Sampler's Pads.
  - Two people reordering one list at once: the later order wins. An item the winning order doesn't know about goes at the end, and nothing is ever lost from a list.

  Giving notes, breakpoints and Pads identities of their own, so that concurrent edits to one Pattern Clip merge note by note, is a later refinement if people clash there.
- **Refusals are visible.** The UI has to say when your Change, or part of your undo, didn't land, and why. Nothing is silently dropped.
- **Everyone has to be on compatible versions** (`SYNC_VERSION`) to apply each other's Changes. Installers and auto-update (#72–#74) keep the Desktop App current, and the Browser Version always is.
- **The Relay is new infrastructure** for the maintainer to run, though a small one that stores nothing.

## How #76 builds it

In slices a reviewer can read one at a time, each test-first against the real Project, commands and validator:

1. **Changes in `ProjectHistory`**: the flat form over the real Project, a diff that skips unchanged subtrees, and undo and redo as conditional Changes. Nothing is shared yet, and every existing history and Request test passes unchanged.
2. **The ordered log**: Lamport clocks, slotting a late Change into place, checkpoints, applying item by item under `validate.ts`, `SYNC_VERSION`, and the UI saying what was refused or left.
3. **Offline sync** (desktop first): *Share this Project* writes the base, `changes/<copy id>.jsonl` and content-hashed audio names; a folder watcher behind `platform.ts`; the Browser Version's part is null and listed in `desktop-only.ts`.
4. **The Relay and Live Sessions**: `relay/`, the encrypted client on both platforms, invite links, catching up from other members, and audio passed through.
5. **Compaction**, once every Collaborator has seen a clock.

## To confirm

The maintainer has to:

1. **Accept the model.** An ordered log of id-keyed Changes, the last write winning per value, the Project kept valid by refusing the later writes that break a rule, and undo as a conditional Change that never overwrites a Collaborator. It changes undo for solo Projects too, and the log becomes part of the Project format, so it is hard to reverse.
2. **Accept offline sync through the musicians' own file-sync service** rather than a Soundcheck server: no accounts, and Soundcheck never holds anyone's songs.
3. **Decide who runs the public Relay, and where**, as [ADR 0012](0012-the-public-relay-runs-from-the-image-ci-publishes.md) sets out. Or decide to run none, so Live Sessions need a Relay the musicians host themselves.
4. **Accept the first version's limits** above: whole-list writes for notes, breakpoints, Pads and list order. Also accept [As #76 built it](#as-76-built-it)'s differences: Live Sessions for any Project, a 2-second poll of the folder, catching up by each copy's last Change, and no compaction yet.
5. **Check by hand** what #76 built, which this sandbox couldn't (one machine, no display, no file-sync service, no Relay deployed):
   - Two Windows machines share a Project folder through OneDrive or Dropbox: one uses *File → Share this Project…*, and the other opens the synced folder. Each edits offline, both reconnect, and each ends with the same song. A Project title says *Shared*.
   - One makes a Request while the other edits, and undoing the Request leaves the other's edits and says what it left.
   - A drum sample loaded on one machine plays on the other once the folder has synced.
   - Run a Relay (`cargo run -p soundcheck-relay`, behind TLS for the browser) and type its address in Settings → Collaboration. Then:
     - One Desktop App starts *File → Live Session…*, and a second joins with the invite link. Each sees the other's edits within a second.
     - Undo on either reaches only its own edit.
     - Pulling the network cable for a minute, then plugging it back in, catches both up.
     - Audio recorded on one plays on the other.
   - The same invite link, opened in Chrome and in Firefox, joins that session in the Browser Version, with its Project and audio.
   - An invite link made in the Desktop App opens the deployed Browser Version. It is built from `VITE_SITE_URL`, whose default in `app/vite.config.ts` has to match where Pages serves it, or a Desktop App build has to set it.
