# Spike: a collaboration sync model that keeps one-step undo (#75)

Throwaway code behind [ADR 0007](../../docs/architectural-decision-record/0007-collaboration-by-an-ordered-log-of-changes.md). It is plain TypeScript that Node runs as it is, with no dependencies and no build, and it sits outside the app's `pnpm test` and `typecheck`. Keep it only as the record of what was proven; #76 builds the real thing in `app/src/project/`, test-first, and doesn't import from here.

```bash
node --test spikes/collab-sync/
```

## What it proves

`sync.test.ts` runs several people's copies of one **Project** (`Replica`s) and passes their Changes between them the way live sync would (after every step) and the way offline sync would (days later, in any order, some twice, as files from a synced folder). It checks that:

- **Undoing your own Request undoes only that Request.** A Request's edits become one Change and one undo step, even when someone else's Changes arrive while it runs. Undoing it leaves everyone else's edits, before and after it, in place (*undoes only the Request*).
- **With nobody else editing, undo is exactly one step back** to the Project as it was, as `ProjectHistory` does today.
- **Undo never overwrites a collaborator.** Where someone else has since changed a value the Request set, undo leaves their value and reports it (*leaves a value someone else changed since*). An item they have moved or changed since is never half removed.
- **Undo restores what it still can.** It brings back a deleted Bus and its Sends around other people's edits. Where a collaborator has since deleted what part of the undo needs (the Bus a Send fed), it restores the rest and refuses that part, and the Project stays valid.
- **Redo survives other people's edits.** Changes arriving from others never clear your redo stack.
- **Every copy converges.** Offline edits merge into the same Project whatever order they arrive in, and a late Change is slotted into its place. Two edits that are each valid but break a rule together (two Sends making a loop) end up with the same one refused everywhere. Two Tracks added at once are both kept. An edit to a Clip that is moved to another Track at the same time goes with the Clip.
- **Random sessions**: three people, 250 random steps each run (edits, undos, redos, partial and duplicated delivery), 8 seeds in the committed test. Every copy stays valid at every step and all end identical, and no undo changes anything outside the items it wrote. A one-off run of 300 seeds passed too.

## How it works, briefly

- `flat.ts`: a Project as a flat map. Every item with an identity (Track, Bus, Clip, Effect, Section, and a Send, known by its Bus) becomes a presence entry plus one entry per field, keyed by its id rather than its position. Each list's order is one entry. Any other array (a Pattern Clip's notes) is a single value. `unflatten` rebuilds the Project from whatever the map holds, deterministically.
- `change.ts`: a Change is a list of writes, each `key: from → to`. An edit's writes land unconditionally, so the last in the order wins. An undo's or redo's writes land only where the key still holds `from`. If what lands would make the Project invalid, the Change is applied item by item, keeping each item only if the Project stays valid.
- `replica.ts`: the Project is the starting point plus every Change, ordered by Lamport clock and then peer. A Change that arrives out of order is slotted in and everything after it is applied again. Undo turns what your step actually did into a new undo Change.
- `project.ts`: a small Project in the app's shape, with the rules from `validate.ts` that two people's edits could break together.

## What it measured

On this sandbox's VM, for a Project of 30 Tracks with 300 Pattern Clips (515 KB of JSON):

- Replaying 500 Changes that arrived ahead of a local one took 390 ms, about 0.8 ms each, validation included.
- A local edit took about 23 ms, because the spike diffs the whole flattened Project every time. The app mustn't do that. Its Projects are never changed in place, so a diff can skip every part of the tree that is still the same object and only look at what a command actually touched.

## What it doesn't do

- **No transport.** Changes are passed as arrays, not over a relay or through files; ADR 0007 describes both.
- **No audio.** The ADR says how audio files travel.
- **No checkpoints or compaction.** It keeps the whole log and every intermediate Project in memory.
- **Not the app's real Project, commands or validator.** Node can't import `app/src/` as it is (its imports have no `.ts` extensions), and a spike shouldn't reach into the app anyway. The flat form is generic, though: nothing in it is specific to this small model beyond the `COLLECTIONS` table.
