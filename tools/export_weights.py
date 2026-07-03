"""Export model weights + style primers into one browser-loadable binary.

Container layout ("CALW" format v1, all little-endian):

    bytes 0-3    magic b"CALW"
    bytes 4-7    uint32 version (1)
    bytes 8-11   uint32 header JSON byte length (space-padded to 4-byte align)
    header JSON  { "dtype": "f32", "meta": {...}, "tensors": {name: {shape, offset, byteLength}} }
    data         concatenated float32 tensor payloads, offsets relative to data start

The meta block carries the alphabet and per-style primer text so the browser
needs exactly one fetch to become a fully working handwriting engine.
"""

from __future__ import annotations

import json
import struct
from importlib.resources import files
from pathlib import Path

import click
import numpy as np

MAGIC = b"CALW"
VERSION = 1
NUM_STYLES = 13

MODEL_TENSORS = [
    "lstm1_kernel", "lstm1_bias",
    "lstm2_kernel", "lstm2_bias",
    "lstm3_kernel", "lstm3_bias",
    "attention_weights", "attention_biases",
    "gmm_weights", "gmm_biases",
]


def load_alphabet() -> list[str]:
    from graves_handwriting_mlx.alphabet import alphabet

    return list(alphabet)


def load_styles(styles_dir) -> list[dict]:
    styles = []
    for style_id in range(NUM_STYLES):
        strokes = np.load(str(styles_dir / f"style-{style_id}-strokes.npy")).astype(np.float32)
        primer = np.load(str(styles_dir / f"style-{style_id}-chars.npy")).tobytes().decode("utf-8")
        styles.append({"id": style_id, "primer": primer, "strokes": strokes})
    return styles


@click.command()
@click.option(
    "--out",
    type=click.Path(dir_okay=False, path_type=Path),
    default=Path(__file__).parent.parent / "packages" / "ink-graves" / "assets" / "graves-v1.bin",
    show_default=True,
)
def main(out: Path) -> None:
    data_dir = files("graves_handwriting_mlx") / "data"
    weights = np.load(str(data_dir / "weights.npz"))

    tensors: dict[str, np.ndarray] = {name: weights[name].astype("<f4") for name in MODEL_TENSORS}
    styles = load_styles(data_dir / "styles")
    for style in styles:
        tensors[f"style_{style['id']}"] = style["strokes"].astype("<f4")

    manifest: dict[str, dict] = {}
    payload = bytearray()
    for name, array in tensors.items():
        raw = np.ascontiguousarray(array).tobytes()
        manifest[name] = {"shape": list(array.shape), "offset": len(payload), "byteLength": len(raw)}
        payload.extend(raw)

    header = {
        "dtype": "f32",
        "meta": {
            "model": "graves-2013-rnn",
            "source": "sjvasquez/handwriting-synthesis checkpoint via breitburg/graves-handwriting-mlx",
            "alphabet": load_alphabet(),
            "maxCharLen": 75,
            "styles": [{"id": s["id"], "primer": s["primer"], "tensor": f"style_{s['id']}"} for s in styles],
        },
        "tensors": manifest,
    }
    header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    header_bytes += b" " * (-len(header_bytes) % 4)

    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<II", VERSION, len(header_bytes)))
        f.write(header_bytes)
        f.write(payload)

    click.echo(f"wrote {out} ({(12 + len(header_bytes) + len(payload)) / 1e6:.1f} MB, {len(tensors)} tensors)")


if __name__ == "__main__":
    main()
