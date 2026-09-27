#!/usr/bin/env sh
# Export htdemucs.onnx, the model Stem Separation installs, into the folder
# named, on Linux or macOS:
#
#     tools/htdemucs-onnx/export.sh            # into the repo's model/
#     tools/htdemucs-onnx/export.sh ~/Models   # anywhere else
#
# Makes a Python venv beside this script (.venv, ~1 GB), installs
# requirements.txt into it, downloads Meta's htdemucs weights (~80 MB, into
# PyTorch's cache, ~/.cache/torch) and writes <folder>/htdemucs.onnx (~300 MB).
# Running it again reuses the venv and the weights. The weights are for
# research and personal use only: see README.md.
set -eu

if [ "$#" -gt 1 ]; then
  echo "usage: $0 [folder to write htdemucs.onnx to, the repo's model/ if none]" >&2
  exit 2
fi
here=$(cd "$(dirname "$0")" && pwd)
# The repo's model/ if none, where the Desktop App and `pnpm dev` look first.
out=${1:-$(cd "$here/../.." && pwd)/model}
# A quoted "~/Models" reaches here unexpanded; mean the home folder by it.
case $out in
  "~") out=$HOME ;;
  "~/"*) out=$HOME/${out#"~/"} ;;
esac
venv="$here/.venv"
python=${PYTHON:-python3}

if [ ! -x "$venv/bin/python" ]; then
  echo "Making a Python venv in $venv…"
  if ! "$python" -m venv "$venv"; then
    echo "Couldn't make a venv with $python. It needs Python 3.11 to 3.14 with venv (on Debian and Ubuntu, apt install python3-venv); name another with PYTHON=…" >&2
    exit 1
  fi
fi
echo "Installing what the export needs…"
"$venv/bin/python" -m pip install --quiet --upgrade pip
"$venv/bin/python" -m pip install --quiet -r "$here/requirements.txt"

mkdir -p "$out"
echo "Exporting htdemucs to $out/htdemucs.onnx…"
PYTHONPATH="$here" "$venv/bin/python" "$here/scripts/convert-pth-to-onnx.py" "$out"
"$venv/bin/python" "$here/check_model.py" "$out/htdemucs.onnx"
echo "Done. Install $out/htdemucs.onnx from Soundcheck the first time you separate Stems."
