# Jev is a Decision Engine beside the Assistant, not a Provider

**Status: proposed** in the pull request that adds it.

[Jev](https://docs.typesafe.ai) is TypeSafe's model for typed decisions (`jev-1.13.0`, September 2026). It is sent a **state** and a map of questions, each a Choice (up to 255 named options), a Score (2 to 10 ordered levels) or a Noul (yes or no), and answers each with the pick, a probability for every option and a confidence. It answers in well under a second and bills only input tokens, at a small fraction of an LLM's price. It can't write text, keep a Conversation or call tools, and TypeSafe's own notes on it ("jaggedness") say it reads questions literally, is poor at numbers and counting, and does best on a short state.

## Decision

**Not a Provider.** Every Request runs a tool-calling loop (`runRequest`), and a Provider's model must use tools (a **Capability** without which it can't be the Assistant). Jev can't, so it isn't listed in the Provider picker, and nothing in `catalogue.ts` describes it.

**A Decision Engine the Assistant asks.** Where Jev is set up, a Request is offered one more core tool, `decide`: the Assistant (Claude or whichever Provider) writes a short state in words and up to 32 questions, the Request asks Jev all of them in one call, and the model is sent each pick with its probabilities and confidence. The Assistant still interprets the Request and makes every change with its other tools; Jev makes the many small bounded musical choices underneath, such as the chord for each bar, the drum pattern for each Section or the Instrument for a part. The system prompt says so and tells the model to decide itself where Jev's confidence is low. `decide` changes nothing, so a Suggestion never makes it again, and without Jev it is neither offered nor mentioned (`RequestMode.decides`). This is the hybrid of [Jevthoven](https://github.com/cocktailpeanut/jevthoven), where code keeps control and renders each pick into notes.

**And directly, where a choice is already bounded.** The Chords Widget's **Next chord from Jev** asks one Choice between its pads, the Song Key's chords and those borrowed from the parallel key, given the key and the chords so far, and adds the pick to the progression. No LLM is involved, so it is fast and nearly free.

**Its connection is kept with the Providers'.** `Settings.jev` holds the musician's TypeSafe key, a model (`jev-latest` unless pinned) and an optional base URL for a gateway, in the same key-store entry, never in a Project. Calls go through the platform's `fetch`, as the Providers' do, to `POST /v1/systemone`; a 429 or 529 is tried again twice with backoff, as TypeSafe's SDKs do, and the response is checked field by field. The TypeScript client is ours (`app/src/assistant/jev.ts`), since TypeSafe's SDK is Python only and the HTTP API is small.

## Consequences

- It is a hosted API, against the local-first direction: what Jev is asked leaves the machine. It is off until the musician enters a key, and Settings says so.
- It is new, and its API and prices may change; the version that answered is reported with every answer, and a version can be pinned.
- It works the same in the Browser Version if TypeSafe (or the gateway) allows CORS from the page; the Desktop App sends its requests from Rust and needs nothing more.
- Only the core tools gain `decide`: it is not in a group, since a Request that has Jev should be able to use it from its first turn.
