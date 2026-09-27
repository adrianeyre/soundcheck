# Spike: Stem Separation with Demucs on ONNX Runtime (#115)

Throwaway code behind ADR 0005. It is its own Cargo workspace, so the app's `pnpm lint`, `test` and `build` never build it. Keep it only as the record of how the numbers were measured.

It runs **htdemucs** (Demucs v4, 4 Stems: drums, bass, other, vocals), exported to a **self-contained ONNX model** by [Mixxx's fork of Demucs](https://github.com/mixxxdj/demucs) (GSoC 2025: the STFT and iSTFT are rebuilt as convolutions inside the graph, from the original weights), through ONNX Runtime via the `ort` crate, on the CPU. `src/main.rs` does what Demucs's own `separate.py` does around the model: standardise by the mono mix, split into 7.8 s chunks overlapping by a quarter, cross-fade them with a triangular weight, and undo the standardisation. It does not do Demucs's random time shifts, so the PyTorch reference is made with `--shifts 0`.

**Licence:** the Demucs code is MIT, but its pretrained weights are for research and personal use only (the author, in [demucs#327](https://github.com/facebookresearch/demucs/issues/327) and [#384](https://github.com/facebookresearch/demucs/issues/384)). Don't commit or publish the `.onnx` file; `.gitignore` keeps it and the audio out.

## 1. Get the model: `htdemucs.onnx` (Python, once)

The model is **`htdemucs.onnx`**: Meta's Demucs v4 "htdemucs" (4 Stems), converted to ONNX by Mixxx's export script. It isn't downloaded from anywhere as an ONNX file: you make it once on your own machine, and the script fetches Meta's official weights (about 80 MB, into PyTorch's cache) itself. The result is about 300 MB. It is the file this spike runs, and the file Soundcheck's model install asks for (#116).

The export's code is in this repo, in [`tools/htdemucs-onnx/`](../../tools/htdemucs-onnx/README.md): the part of Mixxx's fork it needs, with its credits and licence. There is nothing to clone. You need Python 3.11 to 3.14; from the repo's root:

```sh
tools/htdemucs-onnx/export.sh ../onnx-models                                            # Linux or macOS
powershell -ExecutionPolicy Bypass -File tools\htdemucs-onnx\export.ps1 ..\onnx-models   # Windows
```

Either writes `../onnx-models/htdemucs.onnx`, having made a venv in `tools/htdemucs-onnx/.venv` and checked the model's shapes. That folder's README says what each step downloads.

Keep the file to yourself: the weights are for research and personal use only (see the licence note above and ADR 0005), which is why nothing in the repo or the app ships or downloads it.

## 2. The PyTorch reference (same song)

This needs Demucs's whole command line, which `tools/htdemucs-onnx/` leaves out. pip installs it from Mixxx's fork at the same commit, into a venv of its own, with nothing to clone. torchaudio 2.9 and later read and write audio through `torchcodec`, which needs FFmpeg installed on the system:

```bash
python -m venv .venv-reference && . .venv-reference/bin/activate
pip install --extra-index-url https://download.pytorch.org/whl/cpu torch==2.14.0 torchaudio==2.11.0 torchcodec==0.16.0 \
  "demucs @ git+https://github.com/mixxxdj/demucs@d788c1a06876ced89b11d6531f771e5e40204d48"
```

On the Linux dev VM that installs and `demucs --help` runs; without FFmpeg it can't load the song, so the reference below hasn't been made yet.

```bash
demucs -n htdemucs --shifts 0 --overlap 0.25 --float32 --clip-mode none -o ../reference song.wav
# Stems land in ../reference/htdemucs/song/{drums,bass,other,vocals}.wav
```

`--clip-mode none` matters: by default Demucs rescales a whole Stem that peaks over full scale before writing it, which `compare` would count against ONNX Runtime.

## 3. Separate with ONNX Runtime and measure

The song must be a 44.1 kHz WAV (`ffmpeg -i song.mp3 -ar 44100 song.wav`).

```bash
cd spikes/stem-separation
cargo run --release -- separate path/to/onnx-models/htdemucs.onnx song.wav out
cargo run --release -- compare out path/to/reference/htdemucs/song
```

`separate` prints the time per minute of audio, peak memory and the model's size; `compare` prints, per Stem, the largest sample difference from PyTorch and the signal-to-difference ratio in dB.

On a Linux older than glibc 2.38 (Debian 12, Ubuntu 22.04) the ONNX Runtime `ort` downloads won't link; see "Stem Separation" in the top-level README for linking Microsoft's own build instead.

## 4. The app's own separation (#116)

The desktop app has its own port of `src/main.rs` (`desktop/src/stems.rs`; on a fake model the two give the same Stems sample for sample). An ignored test runs it on the real model, installing it as the app would, and prints its time and how close the four Stems sum to the input:

```bash
SOUNDCHECK_HTDEMUCS=path/to/onnx-models/htdemucs.onnx SOUNDCHECK_SONG=song.wav \
  cargo test --release -p soundcheck-desktop real_htdemucs -- --ignored --nocapture
```

Leave out `SOUNDCHECK_SONG` to separate 20 s of test tones instead. On Windows (PowerShell), set the variables first with `$env:SOUNDCHECK_HTDEMUCS = "..."`.

## Results

Filled in from the runs. The song is a 3-minute stereo song from the maintainer's own library, not committed.

| | Linux dev VM (16 vCPU) | Windows (maintainer's machine) |
| --- | --- | --- |
| CPU | | |
| Time for the song | | |
| Seconds per minute of audio | | |
| Peak memory | | |
| Model file | | |

| Stem | Max difference from PyTorch | Signal-to-difference (dB) |
| --- | --- | --- |
| drums | | |
| bass | | |
| other | | |
| vocals | | |

**By ear (maintainer):** go / no-go, and notes on bleed and artifacts per Stem.
