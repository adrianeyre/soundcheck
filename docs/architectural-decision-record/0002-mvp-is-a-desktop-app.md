# The MVP is a desktop app: the browser failed the latency test

Milestone 0 of the [MVP PRD](../product-requirements-document/mvp.md) asked whether the MVP could run in the browser without lag. The browser had to pass all three of its tests. It failed the first: key-to-sound latency was measured at **80 ms** against a limit of 20 ms, and Chrome's own figures (10 ms buffer + 48 ms output latency) show most of that is the browser's and Windows' shared audio path, which a web page can't bypass. So, as the PRD says, the MVP is a desktop app: Tauri, with the Audio Engine on the native audio driver via cpal ([ADR 0001](0001-audio-engine-in-rust.md)).

## What was measured

The prototype from #4 (PR #31, with #32 and #33), run by the author for #5.

| | |
| --- | --- |
| Machine | Windows laptop; model, CPU and Windows version not recorded |
| Browser | Chrome; version not recorded |
| Audio output | The laptop's built-in audio: first its speakers, then a wired phone headset in its headphone jack. No audio interface was available, and a Bluetooth speaker was ruled out (Bluetooth alone adds 100 ms or more). |
| Key input | The computer keyboard (#33). No MIDI keyboard was available. |
| Sample rate / block size | 48 000 Hz / 128 frames |
| Base latency (buffer) | 10.0 ms (480 frames), for every latency hint, including 5 ms |
| Output latency (reported) | 48.0 ms, the same for speakers and headset and from the moment audio started |
| Playback latency (reported, avg / max) | 48.8 ms / 49.9 ms |

| Test | Limit | Result | |
| --- | --- | --- | --- |
| 1. Key-to-sound latency | ≤ 20 ms | **80 ms**, recorded with a phone mic against the headset earcup: key click to the transient. How many presses were measured wasn't recorded. | **Fail** |
| 2. 16 Tracks × (Synth + EQ + Compressor + Reverb), 10 minutes, no dropouts | 0 underruns | Not run to 10 minutes. Partial runs on the headset: 0 underruns at 1:01 and at 1:30. On the laptop speakers: 1 underrun (11.5 ms of silence) in 0:51. | Not completed |
| 3. UI at 60 fps during test 2 | 60 fps | 60 fps with 0 frames over 25 ms in the partial headset runs | Not completed |
| Highest Track count with no underruns | (informational) | Not measured | — |

Tests 2 and 3 were left unfinished because test 1 alone decides the outcome. The partial runs suggest the engine itself is not the problem: 16 Tracks played cleanly in the AudioWorklet.

## What was tried to lower the latency

- Asking Chrome for a 5 ms latency hint instead of *interactive*: no change (10 ms buffer either way).
- Switching from the laptop speakers to a wired headset: no change (48 ms reported for both, most likely because the jack and speakers are one Windows audio device).
- Restarting audio after each change, to make sure Chrome re-read the device.

## Limits of this result

It was measured on built-in laptop audio, not the audio interface the PRD assumed, and with a computer keyboard, not a MIDI keyboard. A good interface with a low-latency Windows driver might report much less output latency. But Chrome can only use Windows' shared audio path (not ASIO or WASAPI exclusive mode), its buffer never went below 10 ms, and the measured 80 ms is four times the limit. A browser pass would need a very different machine, and the MVP is for this author's machine.

## Consequences

- Build the MVP as a Tauri desktop app with cpal. #28 (the desktop shell) is unblocked.
- The PRD's **[desktop]** requirements apply and its **[web]** ones don't. Browser storage for the API key is replaced by the OS keychain.
- Until the Tauri shell exists, the browser AudioWorklet host from #4 remains the dev host that issues are built and tested against. It stays behind the `AudioOutput` interface, so the desktop host replaces it without the UI changing.
- The PRD's open question about recording latency in the browser no longer applies.
- Which desktop OS comes first was a product decision for the PRD, not this ADR. It has since chosen Windows, the author's machine.
- A browser build moves to "consider later" ([v4](../product-requirements-document/v4.md)). *Amended by [ADR 0006](0006-a-browser-version-beside-the-desktop-app.md)*: it ships as the lighter Browser Version beside the Desktop App, which stays the MVP and the low-latency product.
