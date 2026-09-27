# The starter kit: licence and provenance

These eight WAV files are the bundled kit the Drum Sampler loads. They are
part of Soundcheck and are licensed, like the rest of it, under
**GPL-3.0-or-later**. They may be redistributed with the app, and a musician
may use them in their own music without restriction: the GPL covers the
files, not the recordings made with them.

## Where they came from

None of them is a recording, a sample pack, or a copy of anyone else's kit.
Each one is synthesised from scratch by `engine/examples/make_starter_kit.rs`,
which is in this repository and is the only source of these files:

```
cargo run -p soundcheck-engine --example make_starter_kit
```

The generator is deterministic — its noise comes from a seeded xorshift, not
the system's random numbers — so the output is byte for byte the same every
time. Regenerating the kit leaves git clean unless the generator itself has
changed. That is what keeps provenance easy to check: the files are the work
of the code next to them, and nothing about them was sampled from elsewhere.

| File             | Pad        | MIDI note | Choke group | How it is made                                        |
| ---------------- | ---------- | --------- | ----------- | ----------------------------------------------------- |
| `kick.wav`       | Kick       | 36        | –           | A sine swept from 120 Hz down to 45 Hz, with a click   |
| `snare.wav`      | Snare      | 38        | –           | A 190 Hz body and its harmonic under filtered noise    |
| `clap.wav`       | Clap       | 39        | –           | Three quick noise slaps and a noise tail               |
| `closed-hat.wav` | Closed Hat | 42        | 1           | High-passed noise and an 8.2 kHz ring, decaying fast   |
| `open-hat.wav`   | Open Hat   | 46        | 1           | The same, ringing on for about half a second           |
| `low-tom.wav`    | Low Tom    | 45        | –           | A sine swept from 105 Hz to 78 Hz, with a noise attack |
| `high-tom.wav`   | High Tom   | 48        | –           | The same, from 205 Hz to 152 Hz                        |
| `cowbell.wav`    | Cowbell    | 56        | –           | Two detuned square waves, 540 Hz and 800 Hz            |

The notes are the General MIDI drum map's, so a MIDI drum pattern written
elsewhere lands on the pads a musician would expect. The two hi-hats share
choke group 1, so closing the hat cuts the open one off.

## Format

48 kHz, 16-bit, mono, peak-normalised to 0.95 (about -0.45 dBFS) with a 5 ms fade at the
end so a sample never stops on a step. The Drum Sampler resamples whatever it
is given, so a file at another sample rate — including one the musician loads
onto a pad — plays at its own speed.

## Adding samples that aren't ours

If a sample from outside this repository is ever bundled, it goes in this
folder's table with its source and its licence, and that licence must allow
redistribution under GPL-3.0. Anything a musician loads onto a pad themselves
is theirs; it is copied into their own Project folder and never into this
repository.
