# Real-model check of the PRD's Assistant scenarios (#27, #107)

The MVP scenarios come first, then [the v3 stories](#v3-stories-107-not-yet-run),
which have not been run yet.

> **Superseded pending the re-run: the results below were probably GPT-5.5's,
> not Claude's.** The API was reached through a gateway, and the harness
> deleted `ANTHROPIC_CUSTOM_HEADERS` before building its client, on a wrong
> diagnosis of a 503. That variable carries the routing header that stops the
> gateway failing a Claude request over to another provider's accounts. Without it, a
> `claude-opus-5-5` request was since seen answered by `gpt-5.5`, and the
> harness never checked the `model` in its responses, so nothing here shows
> that Claude answered. Read every number below as GPT-5.5's behaviour
> through the Codex fallback. #79 and #80 are unconfirmed on Claude.
>
> **The re-run is blocked on an Anthropic API-key account.** The gateway's
> Claude accounts are Claude subscription (OAuth) accounts, and Anthropic
> refuses requests on them that don't come from Claude Code: a 429 with no
> reset time, which the gateway passes on as a 503. A script like this harness can
> never reach Claude through them, and it won't be made to look like Claude
> Code. It needs a pay-as-you-go Anthropic API-key account, added to the
> gateway or used directly.
>
> The harness is fixed for that run: it keeps the header, proves every
> response came from the chosen provider's model, and waits out a busy API
> (see [How to re-run](#how-to-re-run)). The recorded numbers are left as they
> were.

The MVP PRD's Assistant acceptance criteria, run against the real Claude API
through the app's own code: `claudeConversations` → `runRequest` →
`ProjectHistory`, with `EngineSync` and the real WASM Audio Engine for
rendering and `analyse_audio`. The harness is `app/scripts/real-model-check.ts`.
It never runs in `pnpm test` or CI.

- **Date:** 2026-09-24
- **Model:** `claude-opus-5-5` (`ASSISTANT_MODEL`), with the app's request
  settings unchanged: `max_tokens` 16 000, no `thinking` or `effort` set (so
  the model's default effort), the tools from `TOOL_DEFINITIONS` and the
  system prompt from `context.ts`
- **SDK:** `@anthropic-ai/sdk` 0.128.0
- **Requests sent:** 10 (59 API calls), estimated **US$0.65** in total

## Prompts

1. In a new Project: `make a 4-bar drum beat at 120 BPM with a bassline`
2. On a Project that clips: `the mix is clipping — fix it`

## Summary (superseded)

| Criterion | Result |
| --- | --- |
| "make a 4-bar drum beat at 120 BPM with a bassline" produces a playable result | **Pass** on the objective checks, 2/2 runs. Whether it's *playable* still needs a person to listen to the WAVs. |
| "the mix is clipping — fix it" calls `analyse_audio`, lowers the loud Track or the Master, and a fresh analysis shows no clipping | **Failed** 4/4 before the fix below: every run hit the Assistant's 8-turn limit, and one fixed nothing. **Pass** 4/4 after the fix. |
| One undo after each Request restores the Project exactly | **Pass**, 10/10 Requests |

A bug in `analyse_audio` caused the clipping failures. The model asks for the
whole mix with `trackId: ""`, the tool answered "There is no Track ." and the
model spent its turns trying to get round that. The fix is in the same branch
(see [Bug fixed](#bug-fixed)).

## Scenario 1: build a beat (superseded)

Each run starts from `createProject("Untitled")`. The checks: the Request
ended without error, the tempo is 120, a Drum Sampler Track and a bass Synth
Track each have notes inside the first 4 bars, the Project validates, and the
render is non-silent (peak above -40 dBFS) with no clipped samples. The render
goes to `temp/real-model-check/build-run-N.wav`, 48 kHz / 24-bit.

| | Run 1 | Run 2 |
| --- | --- | --- |
| Result | **Pass** | **Pass** |
| Tool calls | `create_track`, `set_instrument`, `place_clip`, `create_track`, `set_instrument`, `place_clip` | `create_track` ×2, `set_tempo`, `set_instrument` ×2, `place_clip` ×2 |
| Tempo | 120 | 120 |
| Tracks | “Drums”: Drum Sampler (Starter Kit), 1 Clip, 53 notes; “Bassline”: Synth (Sub Bass), 1 Clip, 16 notes | “Drums”: Drum Sampler (Starter Kit), 1 Clip, 56 notes; “Bassline”: Synth (Sub Bass), 1 Clip, 24 notes |
| Length | 4 bars (15 360 ticks), both Clips from bar 1 | 4 bars (15 360 ticks), both Clips from bar 1 |
| Validates | yes | yes |
| Mix | peak -6.9 dBFS, true peak -6.0 dBTP, 0 clipped, -23.8 LUFS | peak -7.7 dBFS, true peak -7.3 dBTP, 0 clipped, -23.1 LUFS |
| Summary shown | “Created a 4-bar beat at 120 BPM with a Starter Kit drum pattern and a Sub Bass bassline.” | “Created a 4-bar beat at 120 BPM with a Drum Sampler “Drums” track and a Sub Bass “Bassline” track. The drums include kick, snare, hats, and a small open-hat variation, with a synced bassline underneath.” |
| Undo | restores exactly | restores exactly |
| Tokens (in / out / cache read) | 25 378 / 1 685 / 2 560, 7 API calls | 4 834 / 2 098 / 10 240, 4 API calls |

Note that 120 BPM is a new Project's default tempo, so the tempo check passes
whatever the model does. In run 2 it set 120 explicitly anyway.

**Listening is still the human's call.** The objective evidence is that
both renders have notes on both Tracks, they are neither silent nor clipping,
and the whole song is 8 s. Whether they groove is for a person to hear:
re-run the harness (it rewrites `build-run-1.wav` and `build-run-2.wav`) and
listen.

## Scenario 2: fix the clipping (superseded)

The song is the Project from scenario 1, run 1, pushed until a fresh analysis
hears it clip (the harness checks this before it sends the Request). There
are two setups:

- **One loud Track:** the loudest Track (by its solo peak), “Drums”, and the
  Master at volume 2 (+6 dB), with “Bassline” at unity. Lowering either the
  Drums or the Master fixes it, which is what the PRD asks for ("finds the loud
  Track or the Master"). The mix clips: 881 clipped samples, true peak
  +2.6 dBTP.
- **Everything pushed:** every Track and the Master at volume 2. 1 259 clipped
  samples, true peak +2.6 dBTP.

Pushing a single Track to its maximum doesn't clip this song on its own: the
mix peaks at -6.9 dBFS and the volume range tops out at +6 dB. That's why the
one-loud-Track setup also pushes the Master.

The checks: the Request ended without error, `analyse_audio` was called, a
channel that had been pushed up was lowered, a fresh analysis afterwards
shows 0 clipped samples, and the Project validates.

### Pass 1, before the fix: 0/4 pass

In this pass the harness meant to run a "loud Track" setup and a "loud
Master" setup. Neither pushed channel clipped on its own, so both fell back
to *everything pushed*, and all four runs started from the same Project
(1 259 clipped samples).

| Run | Tool calls | Lowered | After | Result |
| --- | --- | --- | --- | --- |
| 1 | `analyse_audio` ×5, `set_master_volume`, `set_track_volume` ×2 | Master 2→1, Drums 2→1, Bassline 2→1 | peak -6.9 dBFS, 0 clipped | **Fail**: stopped at the 8-turn limit, no summary |
| 2 | `analyse_audio` ×7, `set_master_volume` | Master 2→0.5 | peak -6.9 dBFS, 0 clipped | **Fail**: stopped at the 8-turn limit, no summary |
| 3 | `analyse_audio` ×5, `set_master_volume`, `set_track_volume`, `analyse_audio` | Master 2→1, Drums 2→1 | peak -6.3 dBFS, 0 clipped | **Fail**: stopped at the 8-turn limit before it read its own check |
| 4 | `analyse_audio` ×8 | nothing | peak 0 dBFS, **1 259 clipped** | **Fail**: stopped at the 8-turn limit with the mix still clipping |

The model made one tool call per turn. To ask for the whole mix, every run
passed `trackId: ""` (or, after the tool refused that, `"master"`,
`"__omit__?"` or `"'left out'"`) rather than leaving `trackId` out. The tool
answered each one with `There is no Track . The Project has: …`. The model
then fell back to per-Track analyses, several of them repeated, and ran out
of turns. Undo still restored the Project exactly in all four runs, and in
run 4 there was nothing to undo.

### Pass 2, after the fix: 4/4 pass

| Setup, run | Tool calls | Lowered | Before → after | Summary shown | Result |
| --- | --- | --- | --- | --- | --- |
| One loud Track, 1 | `analyse_audio`, `set_master_volume`, `analyse_audio` | Master 2→1 | 881 → 0 clipped; peak 0 → -1.2 dBFS; true peak +2.6 → -0.2 dBTP | “Lowered the master volume from 2 to 1. The mix now has 0 clipped samples, with the true peak at -0.2 dBTP.” | **Pass** |
| One loud Track, 2 | `analyse_audio`, `set_master_volume`, `analyse_audio` | Master 2→1 | 881 → 0 clipped; peak 0 → -1.2 dBFS; true peak +2.6 → -0.2 dBTP | “Fixed the clipping by lowering the Master volume from 2 to 1. The mix now has 0 clipped samples, with a true peak of -0.2 dBTP.” | **Pass** |
| Everything pushed, 1 | `analyse_audio`, `set_master_volume`, `analyse_audio` | Master 2→1 | 1 259 → 0 clipped; peak 0 → -0.9 dBFS; true peak +2.6 → 0.0 dBTP | “Lowered the master volume from 2 to 1. The mix now has 0 clipped samples, with peak level below clipping.” | **Pass** |
| Everything pushed, 2 | `analyse_audio`, `set_master_volume`, `analyse_audio` | Master 2→1 | 1 259 → 0 clipped; peak 0 → -0.9 dBFS; true peak +2.6 → 0.0 dBTP | “Lowered the master volume from 2 to 1. The mix now has 0 clipped samples, with peak level safely below clipping.” | **Pass** |

Every run analysed the whole mix (`trackId: ""`, now accepted), lowered the
Master to unity, and analysed again to check the fix, in 4 API calls. Undo
restored the Project exactly each time.

## Scenario 3: one undo restores the Project (superseded)

After every Request the harness calls `ProjectHistory.undo()` once. It then
checks that the undo step was labelled "Request", that nothing more is left
to undo, and that the Project deep-equals the one from before the Request.
It passed after all 10 Requests. In every case the restored Project was the
very same object as before the Request, not just an equal copy. That includes
the four Requests stopped at the turn limit, whose partial changes were
undone as one step.

## Tokens and cost (superseded)

Opus 5.5 prices: US$4 per million input tokens, $20 per million output, $0.20
per million cache reads (and $5 per million cache writes, of which there were
none). Usage is summed from the `usage` of every API response.

| Scenario | Requests | API calls | Input | Output | Cache read | Estimated cost |
| --- | --- | --- | --- | --- | --- | --- |
| 1. Build a beat | 2 | 11 | 30 212 | 3 783 | 12 800 | $0.199 |
| 2. Fix the clipping, pass 1 (before the fix) | 4 | 32 | 57 670 | 2 879 | 99 840 | $0.308 |
| 2. Fix the clipping, pass 2 (after the fix) | 4 | 16 | 28 712 | 1 008 | 44 544 | $0.144 |
| **Total** | **10** | **59** | **116 594** | **7 670** | **157 184** | **$0.651** |

After the fix, a clipping Request costs about 3.6 cents; before it, about
7.7 cents. A build Request costs about 10 cents.

## Bug fixed

**`analyse_audio` refused an empty `trackId`, which is how the model asks for
the whole mix.** The tool description says to leave `trackId` out for the
whole mix, but the model fills in every argument and sent `""`, and the tool
answered "There is no Track ." `analyse_audio` now takes an empty `trackId`,
or `"master"` (the name the effect tools already use for the Master), as the
whole mix. A unit test in `tools.test.ts` covers it. Scenario 2 went from 0/4
to 4/4 passing.

## Bugs to file

1. **The Assistant makes one tool call per turn, so 8 turns is tight for
   listen–fix–check Requests.** Before the fix, each of the 8 turns carried a
   single tool call, and the per-Track analyses the model ran were often
   repeats of one it had already made. The empty-`trackId` fix removed the
   trigger here, but a Request that really needs several analyses (each Track
   on its own, then the fix, then a check) will hit `MAX_TURNS` in
   `assistant.ts` again. When it does, the musician gets no summary, though the
   partial changes stay in and one undo reverts them. Brief: decide whether to
   raise the limit, ask for independent calls (such as several Track analyses)
   in one turn in `context.ts`, or tell the model how many turns it has left.
   Then re-run `real-model-check clipping` with a Project whose fix needs
   per-Track listening.
2. **The clipping fix leaves no true-peak headroom, and the model calls that
   "safely below clipping".** In every run the model set the Master back to
   unity and stopped. With everything pushed, that leaves a true peak of
   0.0 dBTP, and -0.2 dBTP with one loud Track. The loud Track stays at +6 dB
   and was never lowered. The acceptance criterion (no clipped samples) passes,
   but a real mix would still overshoot on conversion. Brief: consider telling
   the model in `context.ts` (or the `analyse_audio` description) to aim below
   a true-peak ceiling such as -1 dBTP, and to prefer lowering the Track that is
   actually too loud over the Master. Check with the one-loud-Track setup.

## v3 stories (#107): not yet run

**Not yet run.** The scenarios are written and their checks are tested, but
no real model has answered them. Running them needs an Anthropic API-key
(pay-as-you-go) account for the Claude run, for the reasons in the note at
the top, and an account with, or a machine running, another Provider. The
sandbox that wrote them has neither, and must not use the gateway's Claude
subscription accounts. A person runs them and fills in the tables below.

`app/scripts/real-model-check-v3.ts` holds the scenarios: the song each
starts from, the Requests sent and the checks on the Projects that come
back, and what a scenario needs besides its song (`scenarioWorld`): audio
files, rendered by the engine when it runs rather than kept in the repo, the
musician's library, held in memory, or listening. `real-model-check.ts`
runs them through the app's own code, as it runs the MVP scenarios. `real-model-check-v3.test.ts` tests every check against
the Projects the Assistant's own tools make when a scripted model does the
story, against near misses (the whole bassline made longer, a fade that
falls back, the chorus moved rather than repeated, a follow-up that takes the
delay away too, a tempo left slow to the end, the Starter Kit loaded for the
saved one, a vocal placed a bar late, a Section over the wrong bars, the
numbers read without listening, a mix changed without comparing) and against
a Request that does nothing, and checks that every v3 story has a scenario or
a waiver. No test calls a model. A dry run of the whole harness against a
fake local server that answers every call with "Done." and no tool calls
(re-run on 2026-09-27 with every scenario below) ran every scenario to its
end and failed each one, as it should, and skipped `listening`, since the
fake model doesn't take audio.

### The song

Every v3 scenario starts from the same song (`v3Song`), not one a model
built, so that a failure is the Request's and not the song's: 16 bars at
120 BPM in 4/4, as **Sections** Intro (bars 1–4), Verse (5–8), Chorus
(9–12) and Outro (13–16). Its Tracks are “Drums” (Starter Kit kick, snare
with a clap, and closed hats), “Bass” (Sub Bass, a short note a beat on each
bar's root), “Pad” (Warm Pad, a triad a bar) and “Lead” (Saw Lead, in the
Chorus only), each Clip one Section long. It peaks at about -18 dBFS. The
Starter Kit is about 16 dB louder than the synths at the same volume, so the
Drums sit at 0.2 and the synths at 0.8. The Drums' hits are at full velocity
all the same, so that pushing the Drums and the Master to 2 makes the mix
clip: that is the one-loud-Track setup when `clipping` runs without a beat
from `build`.

### Scenarios

Each scenario also checks that no Request stopped early, that the Project
validates, and that one undo per Request puts back exactly the Project from
before it (`undoRestores`).

| Scenario | Story | Request(s) | Passes when |
| --- | --- | --- | --- |
| `notes` | 1. Change specific notes | "make the last two notes of the bassline longer" | The Bass's last two notes are longer and start where they did; every other note and Track is as it was. |
| `routing` | 2. Buses, Outputs and Sends | "put the drums and the bass on a new Bus called Rhythm and turn that Bus down a little, then add a Send from the pad to a new Bus called Space" | A Bus named Rhythm exists, the Drums and Bass output to it, its volume is below 1, and the Pad has a Send above 0 to a Bus named Space. |
| `automation` | 3. Draw Automation | "fade the pad in over the first four bars" | The Pad's volume is automated; at bar 1 it is at most a quarter of its value at bar 5, it never falls from bar to bar, and by bar 5 it is back to at least 90% of the Pad's volume. The other Tracks are as they were. |
| `tempo` | 4. Tempo Changes | "slow the chorus down to 100 BPM, then back to 120 for the outro" | Every beat of the Intro and Verse is at 120 BPM, of the Chorus at 100 and of the Outro at 120; the song is still in 4/4, and its Clips and Sections are as they were. |
| `sounds` | 5. Presets and Kits | "save the pad's sound as a User Preset called Dream Pad, save the drums' pads as a Kit called Old Drums, then load my saved 808 Kit onto the drums", with a library holding the Kit “808” (the Starter Kit with a Kick of its own) | A `save_preset` and a `save_kit` call succeeded; the Drums play the Kit “808”, whose Kick's sample was copied into the Project; the Drums' notes and the other Tracks are as they were. |
| `audioclips` | 6. Audio Clips | "put the vocal take on the Vocals track again at the start of the chorus, and trim the verse's vocal to its first two seconds", with an Audio Track “Vocals” playing a 4 s take (the Lead's first two Chorus bars, rendered) from bar 5 | The Vocals have a Clip of the take from the top of the Chorus, all 4 s of it; the Verse's Clip starts where it did and plays the take's first 2 s; the other Tracks are as they were. |
| `sections` | 7. Name the parts as Sections | "name the parts of my song as Sections: it's an intro, a verse, a chorus and an outro, four bars each", with the song's Sections taken away | There are four Sections, an Intro, a Verse, a Chorus and an Outro of four bars each from bars 1, 5, 9 and 13, and nothing else changed. |
| `arrangement` | 8. Duplicate a Section | "repeat the chorus" | There are two Chorus Sections, at bars 9 and 13; every Track's Chorus Clips are still there and copied four bars on; the Outro and its Clips have moved to bar 17; the Intro and Verse are as they were. |
| `buildup` | 9. A build-up into a Section | "add a build-up in the verse into the chorus" | In the Verse's bars (5–8): some Track's notes changed, some channel has new Automation with a breakpoint there, and some Insert Chain changed: notes, Automation and Effects, as the story says. The Chorus is still there. |
| `conversation` | 10. Follow up in a Conversation | 1. "add a reverb and a delay to the lead"; 2. "undo the reverb but keep the rest" | After the first, the Lead has an active reverb and delay. After the follow-up, it has no active reverb, the same delay, the follow-up reported a change, and the other Tracks are as they were. Two undos, one per Request, put back the song. |
| `suggestion` | 12. A Suggestion on a Local model | "mute the pad and turn the bass up a little", made as a **Suggestion** | A Suggestion with changes was offered; the Project was untouched until it was applied; applying it made every change; then the Pad is muted and the Bass louder, and nothing else changed. |
| `listening` | 13. Hear the rendered audio | "listen to the lead in the chorus and tell me whether it sounds harsh; don't change anything", with listening turned on | An `analyse_audio` call asked to listen, the model was sent the audio with its result, and nothing changed. It runs only on a model that takes audio (the catalogue's audio input: Gemini's today); on any other it is printed as SKIPPED and recorded as skipped, not as a result. |
| `compare` | 14. Did that fix it? | "the bass is too loud in the mix: turn it down, then check whether that fixed it", with the Bass at volume 2, about 8 dB above anything else | The Bass is lower, `analyse_audio` was called at least twice, and a `compare_audio` call succeeded. |
| `reference` | 15. Compare with a Reference Track | "compare my mix with the reference track and make it closer to it, then check that it is", with a Reference Track that is the song's Verse and Chorus rendered with the Bass at 2 | A `compare_to_reference` call succeeded, the mix changed, a second comparison succeeded after it, and the Reference Track is still the Project's. |
| `clipping` (one loud Track) | 16. Fixing clipping | "the mix is clipping — fix it", with the loudest Track and the Master at 2 | As in the MVP scenario above, and also: the mix ends at or below -1 dBTP (`withinCeilingAfter`) and the loud Track was lowered (`loweredTheLoudTrack`). |

Every v3 story has a scenario but one. **Story 11 is waived** (`V3_WAIVERS`):
seeing the Conversation and starting a new one is the UI alone, and sends
the model nothing a scenario could check. `RequestBox.test.tsx` covers it
("a follow-up is sent the Request before it, the transcript shows both, and
New conversation clears it"); what the model is sent of a Conversation is the
`conversation` scenario. The scripted tests for each story stay as they were:
4 `time.test.ts`, 5 `sounds.test.ts`, 6 `audio-clips.test.ts`, 7
`Timeline.test.tsx` and `arrangement.test.ts`, 13 `listening.test.ts`, 15
`reference.test.ts`.

**The Provider's mode.** Each Request runs as the app would run it for the
Provider (`requestModeFor`): Claude, OpenAI and Gemini get the whole core,
applied as it goes; Local gets the smaller core and Suggestions. For a Local
run, the check applies each Suggestion as the musician would, so every
scenario still checks the changes; `suggestion` alone checks that nothing
changes until it is applied. On any other Provider `suggestion` turns
Suggestion mode on, with that Provider's core.

**Tokens against the summary budget.** For each Request the harness counts
its first message (`requestMessage`: the Project summary, the library and,
for a follow-up, the Conversation so far) as the budget counts it,
characters over 2.5 (`estimatedTokens` in `context.ts`), against
`SUMMARY_TOKEN_BUDGET`, 16,000 tokens. It prints that beside the first API
call's whole prompt as the API counted it (input, cache writes and cache
reads: the system prompt, the tools and the summary), and ends with the
largest first message of the run. The v3 song is small, so its summaries
will be far under the budget (about 1,000 tokens at most in the dry run); the budget is
for a 5-minute, 16-Track song, which `read.test.ts` measures.

### Results

Two runs of each scenario per model, as the MVP scenarios have. Fill in
PASS or FAIL, with the checks that failed.

| Scenario | Claude (model: not yet run) | Other Provider (not yet run) |
| --- | --- | --- |
| `notes` | not yet run | not yet run |
| `routing` | not yet run | not yet run |
| `automation` | not yet run | not yet run |
| `tempo` | not yet run | not yet run |
| `sounds` | not yet run | not yet run |
| `audioclips` | not yet run | not yet run |
| `sections` | not yet run | not yet run |
| `arrangement` | not yet run | not yet run |
| `buildup` | not yet run | not yet run |
| `conversation` | not yet run | not yet run |
| `suggestion` | not yet run | not yet run |
| `listening` (a model that takes audio only) | not yet run | not yet run |
| `compare` | not yet run | not yet run |
| `reference` | not yet run | not yet run |
| `clipping` (one loud Track): ≤ -1 dBTP, loud Track lowered | not yet run | not yet run |

| Tokens | Claude | Other Provider |
| --- | --- | --- |
| Largest first message, against the 16,000-token summary budget | not yet run | not yet run |
| First call's whole prompt, as the API counted it (smallest to largest) | not yet run | not yet run |
| Requests, API calls and estimated cost | not yet run | not yet run |

**Bugs filed:** none yet. Each failure goes in as a `bug` issue with the
`needs-triage` and `classified` labels, linked here, with the scenario, the
model, the tool calls and the check that failed from the JSON record.

### Running the v3 scenarios

At least one Claude model and one other Provider. Local is the natural
second: it is the Provider `suggestion` is for, and needs no account, only a
model served by Ollama or llama.cpp that takes tools.

```sh
pnpm engine:build
ANTHROPIC_API_KEY=… pnpm --filter @soundcheck/app real-model-check v3                        # Claude's default model
pnpm --filter @soundcheck/app real-model-check v3 \
  --provider local --model qwen3:8b                  # a Local model on Ollama; LOCAL_BASE_URL for another server
OPENAI_API_KEY=… pnpm --filter @soundcheck/app real-model-check v3 --provider openai         # or OpenAI, or Gemini
GEMINI_API_KEY=… pnpm --filter @soundcheck/app real-model-check listening --provider gemini  # story 13: a model that takes audio
```

`listening` turns listening on, as the musician does in the app, and runs
only where the catalogue says the model takes audio; Claude, OpenAI, Grok
and Local models skip it, so story 13 needs a run on one that does, such as
Gemini's.

`v3` is every v3 scenario and the clipping fix; one scenario can be named on
its own (`… real-model-check conversation`), and with no scenario every MVP
and v3 scenario runs. With `clipping` but not `build`, the song made to clip
is the one saved by the last passing build, or else the v3 song. The run
ends with a PASS or FAIL line for each scenario and run, naming the checks
that failed; the JSON record in `temp/real-model-check/` has the rest (each
Request's tool calls and results, the loaded tool groups, what a Suggestion's
apply did, the Tracks, Buses and Sections after, and every check).

**Cost.** 30 v3 Requests (28 on a model that doesn't take audio, which
skips `listening`) and 4 clipping Requests a model. The only price on
record is Opus 5.5's; at the MVP run's 4 to 10 cents a Request (measured on
GPT-5.5, as the note at the top says) that is roughly US$1–2.50 for `v3` on
Opus 5.5, more if the models load several tool groups and listen often.

## How to re-run

It calls a real model and costs money. The superseded run's token use, at
Opus 5.5 prices, put all 6 Requests (2 builds, then 2 runs of each clipping
setup) at roughly US$0.35; that was measured on GPT-5.5, so take it as a
rough guide only.

**It needs an Anthropic API-key account.** Claude subscription (OAuth)
credentials refuse traffic that doesn't come from Claude Code, and so does a
gateway pool made only of them. Behind any gateway, point the harness at an
API-key account. Don't make the harness look like Claude Code.

```sh
pnpm engine:build                                     # the WASM engine the harness loads
ANTHROPIC_API_KEY=… pnpm --filter @soundcheck/app real-model-check           # everything, MVP and v3, on Claude's default model
ANTHROPIC_API_KEY=… pnpm --filter @soundcheck/app real-model-check mvp       # the MVP scenarios only
ANTHROPIC_API_KEY=… pnpm --filter @soundcheck/app real-model-check build     # scenario 1 only
ANTHROPIC_API_KEY=… pnpm --filter @soundcheck/app real-model-check clipping  # scenario 2 only
```

Through a gateway, also set the base URL and keep any routing header it needs:

```sh
ANTHROPIC_BASE_URL=https://… \
ANTHROPIC_CUSTOM_HEADERS='<routing header>: <value>' \
ANTHROPIC_API_KEY=… pnpm --filter @soundcheck/app real-model-check
```

**Provider, model and version.** The conversations are built by the app's
provider layer (`conversationsFor`), so a run can target any provider the
Assistant can, with the Model and Version pickers' names or the API's own id:

```sh
… real-model-check --provider claude --model Opus --version 5.5    # the default
… real-model-check --model Sonnet --version 5 --effort high
… real-model-check --model claude-haiku-4-5
… real-model-check --provider openai                               # OPENAI_API_KEY
… real-model-check --provider gemini --model Pro                   # GEMINI_API_KEY
… real-model-check --provider grok --version 4.3                   # XAI_API_KEY
… real-model-check --provider local --model qwen3:8b               # no key; LOCAL_BASE_URL
```

Left out, the provider is Claude and the model the catalogue's default
(`catalogue.ts`). Each provider reads `<PREFIX>_API_KEY`, `<PREFIX>_BASE_URL`
and `<PREFIX>_CUSTOM_HEADERS`, with the prefix `ANTHROPIC`, `OPENAI`, `GEMINI`,
`XAI` or `LOCAL`. The first lines of the output name the provider, model, effort,
base URL and the custom headers sent (names only; no key or header value is
printed).

**The custom headers are sent on every request.** They are passed to the
provider layer as the connection's headers, as the app would send them, and
a request that is about to go without one of them isn't sent.

**The model check.** The model named by every API response (`model`, or
Gemini's `modelVersion`) is recorded, printed after each Request as
"answered by", and kept in the JSON record. If any response names a model
that isn't the chosen provider's (for Claude, one that doesn't start with
`claude`), or names none, the harness sends nothing more, prints **NOT RUN**
with the reason and exits with status 1. Such a run is not a result, and none
of its numbers should be reported. A Local server can answer with any name it
likes and has no other provider to fail over to, so there any named model
passes.

**A busy API.** A 429 or 503 is retried: for as long as its `retry-after`
or rate-limit reset headers ask, or else with backoff from 5 s up to 60 s,
logging each wait, for up to 10 minutes of waiting per Request. After that the
run stops as not run. A 429 with no reset time stops it at once: it most
likely means subscription credentials refusing traffic that doesn't come from
Claude Code, and an API-key account is needed. Through a gateway that refusal
arrives as a 503 instead, so a 503 that lasts the full 10 minutes most likely
means the same.

`clipping` on its own uses the song saved by the last build run that passed
(`temp/real-model-check/song.json`). The WAVs, that song and a JSON record of
every run (provider, model, the models that answered, waits, tool calls, tool
results, the model's words, usage and each check, and the Request that
stopped a run that didn't finish) go to `temp/real-model-check/`, which is
gitignored.
