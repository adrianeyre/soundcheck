# The Mix Helper asks the Assistant's Provider and Jev outside a Request

**Status: proposed** in the pull request that adds the **Mix Helper** to the **Mixer page** ([its PRD](../product-requirements-document/mixing.md), stories 43 to 45).

The Mix Helper helps a DJ mix harmonically: given what is on the **Decks**, which of the **Track browser**'s tracks would mix in next, by key on the Camelot wheel and by tempo. The DJ wants the **Assistant** and Jev to help with it where they are set up. But the Mixer page is not the **Project** ([ADR 0013](0013-the-dj-mixer-runs-in-the-audio-engine.md)), and a **Request** is: it opens with the **Project Summary** and the Assistant's long system prompt, runs a tool-calling loop over the Project, and is one undo step. None of that fits picking a track.

## Decision

**The app ranks; the models only pick from its ranking.** The ranking is pure and instant (`app/src/dj/mix-helper.ts`): every analysed track not on a Deck, scored by its key's relation to the chosen Deck's on the Camelot wheel and the tempo change that beat-matches it, and marked down where it clashes with another Deck playing. It works with no model at all. The Assistant and Jev are only sent tracks from it and only ever answer with them: a pick of a track they weren't sent is dropped, and loading a pick is left to the DJ.

**The Assistant's Provider, through a one-off exchange, not a Request.** `StartExchange` opens a conversation with the musician's chosen Provider, on the same key, model, effort and gateway as its Requests (`exchangesFor` beside `conversationsFor`), but with its own system prompt and first message and none of the Project. Each Provider's conversation now opens from an `Opening` (a system prompt, earlier exchanges and a first message), which a Request builds as it always did (`requestOpening`). The Mix Helper sends one turn with one tool, `suggest_tracks`, and reads the call. It changes nothing, so it is no undo step, isn't in the Request box's transcript or **Token Usage**, and isn't a **Conversation**.

**Jev directly, as the Chords Widget asks it.** One Choice between the ranking's best 24, with each track's key and tempo in words (Jev reads numbers poorly), given a short state of the Decks. Its probabilities order its picks.

**Every file analysed as it is added.** A track needs its BPM and key to be matched, and until now got them only when a Deck loaded it. `dj_analyse` runs the Decks' own analysis (`dj/analysis.rs`) at the file's own rate, so it needs no audio running, in the UI's WASM build on both platforms, as the Reference Track is measured. The session analyses the Track browser's files one at a time as they are added.

## Consequences

- What the Mix Helper asks leaves the machine: the titles of the DJ's tracks, their BPM and keys, and what is on each Deck go to the Provider or TypeSafe. It asks only when the DJ presses its button, and only where the musician has set that one up.
- The Mixer page is no longer entirely unseen by the Assistant's Provider, but a Request still never sees it.
- Analysis on the page's thread can make it stutter for a moment per long track while files are being added; a Web Worker would avoid that, and is left for later.
- A Provider whose model calls no tool, or calls it with tracks it wasn't sent, gives no picks; the Mix Helper says so and its own ranking stands.
