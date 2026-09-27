"""Check an exported htdemucs.onnx has the shapes Soundcheck installs.

Soundcheck's own, not Mixxx's: the same check the app makes when it installs
the model (`desktop/src/stems.rs`, `app/src/stems/browser-stem-separator.ts`),
so a wrong file is caught here rather than in the app.

    python check_model.py path/to/htdemucs.onnx
"""

import sys

import onnxruntime

# 7.8 s at 44.1 kHz, htdemucs' training segment; four Stems of two sides.
INPUT_SHAPE = [1, 2, 343980]
OUTPUT_SHAPE = [1, 4, 2, 343980]


def main(path):
    session = onnxruntime.InferenceSession(path, providers=["CPUExecutionProvider"])
    inputs, outputs = session.get_inputs(), session.get_outputs()
    if len(inputs) != 1 or len(outputs) != 1:
        sys.exit(f"{path} has {len(inputs)} inputs and {len(outputs)} outputs; htdemucs has one of each.")
    for what, found, expected in (("input", inputs[0], INPUT_SHAPE), ("output", outputs[0], OUTPUT_SHAPE)):
        if found.type != "tensor(float)" or found.shape != expected:
            sys.exit(f"{path}'s {what} is {found.type} {found.shape}, where htdemucs' is float {expected}.")
    print(f"{path} is htdemucs: input {INPUT_SHAPE}, output {OUTPUT_SHAPE}.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python check_model.py path/to/htdemucs.onnx")
    main(sys.argv[1])
