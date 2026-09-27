# htdemucs → ONNX: the model Stem Separation installs

Soundcheck's **Stem Separation** runs **htdemucs** (Demucs v4) as a self-contained ONNX model, `htdemucs.onnx` ([ADR 0005](../../docs/architectural-decision-record/0005-stem-separation-with-htdemucs-on-onnx-runtime.md)). Its weights are for research and personal use only, so neither this repo nor its releases hold or download them for you: **you export the model once, on your own machine, with the code in this folder**, then install it from that file in the Desktop App or the Browser Version.

## Export it

You need Python 3.11 to 3.14 (from [python.org](https://www.python.org/downloads/) on Windows; on Debian and Ubuntu, `python3-venv` too), about 2 GB of disk and a network connection. Linux x86-64 and ARM, Windows x64 and Apple-silicon Macs on macOS 14 or later: PyTorch 2.14 has no build for Intel Macs. From the repo's root:

```sh
pnpm htdemucs:export
```

That writes `model/htdemucs.onnx` in the repo, where the Desktop App and `pnpm dev` look for it first, so they install it without asking. `model/` is gitignored. To write it anywhere else, name a folder: `pnpm htdemucs:export ~/Models`. Or run the script it runs yourself, with the same optional folder:

```sh
# Linux or macOS
tools/htdemucs-onnx/export.sh
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File tools\htdemucs-onnx\export.ps1
```

It:

1. makes a Python venv in `tools/htdemucs-onnx/.venv` (about 1 GB) and installs [`requirements.txt`](requirements.txt) into it: PyTorch for the CPU, from PyTorch's own index;
2. downloads Meta's pretrained htdemucs weights (about 80 MB) from `dl.fbaipublicfiles.com` into PyTorch's cache, `~/.cache/torch/hub/checkpoints/` (`%USERPROFILE%\.cache\torch\hub\checkpoints\` on Windows);
3. writes `htdemucs.onnx` (about 300 MB) into `model/`, or your folder, and checks it has the shapes the app installs: input `[1, 2, 343980]`, output `[1, 4, 2, 343980]`.

It takes about a minute once everything is downloaded. Running it again reuses the venv and the weights. Once you have `htdemucs.onnx` you can delete `.venv` and the cached weights; the app keeps its own copy of the model when you install it.

To run the tests Mixxx wrote for the export (they need no weights): `.venv/bin/python -m pytest tests` from this folder (`.venv\Scripts\python -m pytest tests` on Windows).

Nothing here runs in `pnpm lint`, `test` or `build`, which need no Python.

## Where this code came from, and who wrote it

Everything in this folder but `README.md`, `requirements.txt`, `check_model.py`, `export.sh` and `export.ps1` is copied from **[Mixxx's fork of Demucs](https://github.com/mixxxdj/demucs)**, at commit [`d788c1a06876ced89b11d6531f771e5e40204d48`](https://github.com/mixxxdj/demucs/tree/d788c1a06876ced89b11d6531f771e5e40204d48) of its `main`, byte for byte except where marked below. Only what the export reaches is here; training, evaluation, the grids, the notebook, the sample audio and the images are left out.

- **Demucs** is by **Alexandre Défossez and the Demucs authors at Meta AI** ([facebookresearch/demucs](https://github.com/facebookresearch/demucs); *Hybrid Transformers for Music Source Separation*, Rouard, Massa and Défossez, ICASSP 2023). `demucs/` is theirs, as the files' headers say, and so are the pretrained weights the export downloads.
- **The ONNX export** is **Mixxx's**: Anmol Mishra's Google Summer of Code 2025 project, mentored by Jörg (JoergAtGithub) and Antoine (acolombier) ([the write-up](https://mixxx.org/news/2025-10-27-gsoc2025-demucs-to-onnx-dhunstack/)). It rebuilds the STFT and iSTFT as convolutions inside the graph from the original weights, so the model needs nothing outside it: `demucs/stft.py`, `demucs/istft.py`, the `onnx_exportable` paths in `demucs/htdemucs.py` and `demucs/spec.py`, `scripts/convert-pth-to-onnx.py`, and `tests/`.

| File | From Mixxx's fork | Changed here |
| --- | --- | --- |
| `LICENSE` | `LICENSE` | No |
| `demucs/__init__.py`, `apply.py`, `demucs.py`, `hdemucs.py`, `htdemucs.py`, `istft.py`, `pretrained.py`, `py.typed`, `repo.py`, `spec.py`, `states.py`, `stft.py`, `transformer.py`, `utils.py` | `demucs/` | No |
| `demucs/remote/files.txt`, `demucs/remote/htdemucs.yaml` | `demucs/remote/` | No: they say where `get_model` downloads htdemucs from |
| `tests/test_stft.py`, `test_istft.py`, `test_onnx_flag.py` | `tests/` | No |
| `scripts/convert-pth-to-onnx.py` | `scripts/` | Yes, two changes, each marked `Changed for Soundcheck`: it passes `dynamo=False`, as PyTorch 2.9 made the `torch.export` exporter the default and it fails on an `assert` in `hdemucs.pad1d`; and it exits with an error when the export fails, where it printed one and exited 0 |

Mixxx's fork runs the script after `pip install .`; here `export.sh` and `export.ps1` put this folder on `PYTHONPATH` instead, so `setup.py` isn't needed.

## Licences

- **The code** (Meta's and Mixxx's) is under the **MIT License**, kept unchanged in [`LICENSE`](LICENSE) with Meta's copyright notice; Mixxx's files carry their own "Mixxx Development Team" notice under the same licence. MIT is compatible with Soundcheck's GPL-3.0-or-later: the code is used and redistributed here under MIT's terms, whose one condition, keeping the copyright and permission notice with it, `LICENSE` and the files' headers meet. Soundcheck's own files in this folder are GPL-3.0-or-later like the rest of the repo.
- **The weights are not MIT.** Meta's pretrained htdemucs weights are for **research and personal use only** (Demucs's author, in [demucs#327](https://github.com/facebookresearch/demucs/issues/327) and [#384](https://github.com/facebookresearch/demucs/issues/384)), because the music they were trained on is. The `htdemucs.onnx` you export holds them, so it is yours to use personally and not to share. Soundcheck never downloads, bundles or redistributes it (ADR 0005), and `.gitignore` keeps any `.th`, `.pth` and `.onnx` out of the repo.
