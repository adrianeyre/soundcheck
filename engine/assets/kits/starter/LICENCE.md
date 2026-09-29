# The starter kit: licence and provenance

These 22 WAV files are the bundled kit the Drum Sampler loads. They are
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

| File                 | Pad            | MIDI note | Choke group | How it is made                                                        |
| -------------------- | -------------- | --------- | ----------- | --------------------------------------------------------------------- |
| `kick.wav`           | Kick           | 36        | –           | A sine swept from 120 Hz down to 45 Hz, with a click                  |
| `snare.wav`          | Snare          | 38        | –           | A 190 Hz body and its harmonic under filtered noise                   |
| `clap.wav`           | Clap           | 39        | –           | Three quick noise slaps and a noise tail                              |
| `closed-hat.wav`     | Closed Hat     | 42        | 1           | High-passed noise and an 8.2 kHz ring, decaying fast                  |
| `open-hat.wav`       | Open Hat       | 46        | 1           | The same, ringing on for about half a second                          |
| `low-tom.wav`        | Low Tom        | 45        | –           | A sine swept from 105 Hz to 78 Hz, with a noise attack                |
| `high-tom.wav`       | High Tom       | 48        | –           | The same, from 205 Hz to 152 Hz                                       |
| `cowbell.wav`        | Cowbell        | 56        | –           | Two detuned square waves, 540 Hz and 800 Hz                           |
| `hard-kick.wav`      | Hard Kick      | 35        | –           | A sine bent from about 490 Hz to 55 Hz, driven into a soft clip       |
| `rimshot.wav`        | Rimshot        | 37        | –           | 1.72 kHz and 470 Hz sines and a band-passed noise snap, very short    |
| `electric-snare.wav` | Electric Snare | 40        | –           | A sine bent from 330 Hz to 215 Hz under bright, snappy noise          |
| `low-floor-tom.wav`  | Low Floor Tom  | 41        | –           | A sine swept from 82 Hz to 60 Hz, with a noise attack                 |
| `pedal-hat.wav`      | Pedal Hat      | 44        | 1           | Band-passed noise around 7.5 kHz, swelling in over 4 ms, dying fast   |
| `mid-tom.wav`        | Mid Tom        | 47        | –           | A sine swept from 150 Hz to 112 Hz, with a noise attack               |
| `crash.wav`          | Crash          | 49        | –           | High-passed noise and six inharmonic square waves, over a second      |
| `ride.wav`           | Ride           | 51        | –           | Four inharmonic sine partials, a bell, over a quieter metallic wash   |
| `tambourine.wav`     | Tambourine     | 54        | –           | Band-passed noise and four jingle sines, hit and shaken again         |
| `splash.wav`         | Splash         | 55        | –           | The Crash's recipe, brighter and in half a second                     |
| `hi-conga.wav`       | Hi Conga       | 62        | –           | A 345 Hz sine that sags as it rings, and a band-passed hand slap      |
| `low-conga.wav`      | Low Conga      | 64        | –           | The same at 215 Hz, ringing longer                                    |
| `maracas.wav`        | Maracas        | 70        | –           | Band-passed noise around 6.8 kHz that swells in over 9 ms             |
| `claves.wav`         | Claves         | 75        | –           | A 2.48 kHz sine with a faint overtone, barely ringing                 |

The notes are the General MIDI drum map's, so a MIDI drum pattern written
elsewhere lands on the pads a musician would expect. The three hi-hats share
choke group 1, so closing the hat, with the stick or the pedal, cuts the open
one off.

The first eight are the kit as it first shipped, in that order, and the rest
follow by note. The order matters: a pad with no sample of its own plays the
file at its own place in this list, so a Project saved when the kit had only
eight pads still hears the same eight sounds.

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
