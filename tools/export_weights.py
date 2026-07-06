"""Export model weights + style primers into browser-loadable binaries.

Two artifacts per run:

1. The shipped asset (CALW v2, `--out`): int8 weight matrices with
   per-output-column float32 scales, float32 biases, and one baked
   "primed" state per style. Style priming (teacher-forcing the style's
   recorded strokes, ~400-900 LSTM steps) is precomputed here against the
   exact dequantized weights the file ships, so engines restore a 2.5 KB
   state instead of replaying strokes: styled writes start instantly.
   The primer stroke tensors are dropped from this container.

2. The reference fixture (CALW v1, `--f32-out`, gitignored next to the
   MLX golden vectors): the original float32 weights plus style stroke
   tensors, exactly the historical shipped format. The cell-level golden
   tests (TS and Swift) run against this file, because MLX parity
   tolerances only hold for unquantized weights.

Container layout (all little-endian):

    bytes 0-3    magic b"CALW"
    bytes 4-7    uint32 version (1 = all-f32, 2 = mixed dtypes)
    bytes 8-11   uint32 header JSON byte length (space-padded to 4-byte align)
    header JSON  v1: { "dtype": "f32", "meta": {...},
                       "tensors": {name: {shape, offset, byteLength}} }
                 v2: { "dtype": "mixed", "meta": {...},
                       "tensors": {name: {shape, dtype: "f32"|"q8", offset,
                                          byteLength[, scaleOffset,
                                          scaleByteLength, scaleDtype]}} }
    data         concatenated tensor payloads, offsets relative to data
                 start; v2 pads each payload to 4-byte alignment

A "q8" tensor of shape (rows, cols) stores int8 values row-major plus a
float32 scale per column: weight[r][c] = int8[r * cols + c] * scale[c].

A baked primed state is a float32 vector of length 2483 laid out as
h1(400) c1(400) h2(400) c2(400) h3(400) c3(400) kappa(10) w(73) — the
loader must copy the slices in exactly this order (STATE_LAYOUT below).
"""

from __future__ import annotations

import json
import struct
from importlib.resources import files
from pathlib import Path

import click
import numpy as np

MAGIC = b"CALW"
NUM_STYLES = 13

HIDDEN = 400
ATTENTION_MIXTURES = 10
ALPHABET_SIZE = 73
MAX_CHARS = 120

MODEL_TENSORS = [
    "lstm1_kernel", "lstm1_bias",
    "lstm2_kernel", "lstm2_bias",
    "lstm3_kernel", "lstm3_bias",
    "attention_weights", "attention_biases",
    "gmm_weights", "gmm_biases",
]

QUANTIZED_TENSORS = [
    "lstm1_kernel", "lstm2_kernel", "lstm3_kernel",
    "attention_weights", "gmm_weights",
]

# (name, length) slices of the baked primed-state vector, in storage order.
STATE_LAYOUT = [
    ("h1", HIDDEN), ("c1", HIDDEN),
    ("h2", HIDDEN), ("c2", HIDDEN),
    ("h3", HIDDEN), ("c3", HIDDEN),
    ("kappa", ATTENTION_MIXTURES), ("w", ALPHABET_SIZE),
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


def quantize_q8(w: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Symmetric int8 with one scale per output column. Returns (q, scales, dequant)."""
    scale = np.abs(w).max(axis=0) / 127.0
    scale[scale == 0] = 1.0
    scale = scale.astype("<f4")
    q = np.clip(np.rint(w / scale), -127, 127).astype(np.int8)
    return q, scale, q.astype("<f4") * scale


def sigmoid(v: np.ndarray) -> np.ndarray:
    return (1.0 / (1.0 + np.exp(-v))).astype(np.float32)


def softplus(v: np.ndarray) -> np.ndarray:
    return np.logaddexp(np.float32(0), v).astype(np.float32)


def bake_primed_state(tensors: dict[str, np.ndarray], alphabet: list[str], style: dict) -> np.ndarray:
    """Teacher-force the style's strokes through the cell (numpy mirror of
    packages/ink-graves/src/cell.ts) with a primer-only char sequence, and
    return the state vector in STATE_LAYOUT order. Float32 throughout."""
    index = {ch: i for i, ch in enumerate(alphabet)}
    encoded = [index.get(ch, 0) for ch in style["primer"]] + [0]
    char_length = len(encoded)

    k1, b1 = tensors["lstm1_kernel"], tensors["lstm1_bias"]
    k2, b2 = tensors["lstm2_kernel"], tensors["lstm2_bias"]
    k3, b3 = tensors["lstm3_kernel"], tensors["lstm3_bias"]
    k_att, b_att = tensors["attention_weights"], tensors["attention_biases"]

    h1 = np.zeros(HIDDEN, np.float32)
    c1 = np.zeros(HIDDEN, np.float32)
    h2 = np.zeros(HIDDEN, np.float32)
    c2 = np.zeros(HIDDEN, np.float32)
    h3 = np.zeros(HIDDEN, np.float32)
    c3 = np.zeros(HIDDEN, np.float32)
    kappa = np.zeros(ATTENTION_MIXTURES, np.float32)
    w = np.zeros(ALPHABET_SIZE, np.float32)
    positions = np.arange(MAX_CHARS, dtype=np.float32)

    def lstm(gates: np.ndarray, h: np.ndarray, c: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        i, j, f, o = np.split(gates, 4)
        c_new = (sigmoid(f) * c + sigmoid(i) * np.tanh(j)).astype(np.float32)
        return (sigmoid(o) * np.tanh(c_new)).astype(np.float32), c_new

    strokes = style["strokes"]
    for t in range(strokes.shape[0]):
        x = strokes[t].astype(np.float32)

        h1, c1 = lstm(np.concatenate([w, x, h1]) @ k1 + b1, h1, c1)

        att = softplus(np.concatenate([w, x, h1]) @ k_att + b_att)
        kappa = (kappa + att[20:30] / 25.0).astype(np.float32)
        beta = np.maximum(att[10:20], 0.01)
        diff = kappa[:, None] - positions[None, :]
        phi = (att[0:10, None] * np.exp(-(diff * diff) / beta[:, None])).sum(axis=0).astype(np.float32)
        w = np.zeros(ALPHABET_SIZE, np.float32)
        for u in range(char_length):
            w[encoded[u]] += phi[u]

        h2, c2 = lstm(np.concatenate([x, h1, w, h2]) @ k2 + b2, h2, c2)
        h3, c3 = lstm(np.concatenate([x, h2, w, h3]) @ k3 + b3, h3, c3)

    parts = {"h1": h1, "c1": c1, "h2": h2, "c2": c2, "h3": h3, "c3": c3, "kappa": kappa, "w": w}
    return np.concatenate([parts[name] for name, _ in STATE_LAYOUT]).astype("<f4")


def pack_header(header: dict) -> bytes:
    header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return header_bytes + b" " * (-len(header_bytes) % 4)


def write_v1(out: Path, meta: dict, tensors: dict[str, np.ndarray]) -> int:
    manifest: dict[str, dict] = {}
    payload = bytearray()
    for name, array in tensors.items():
        raw = np.ascontiguousarray(array.astype("<f4")).tobytes()
        manifest[name] = {"shape": list(array.shape), "offset": len(payload), "byteLength": len(raw)}
        payload.extend(raw)
    header_bytes = pack_header({"dtype": "f32", "meta": meta, "tensors": manifest})
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<II", 1, len(header_bytes)))
        f.write(header_bytes)
        f.write(payload)
    return 12 + len(header_bytes) + len(payload)


def write_v2(out: Path, meta: dict, tensors: dict[str, np.ndarray]) -> int:
    manifest: dict[str, dict] = {}
    payload = bytearray()

    def append(raw: bytes) -> int:
        offset = len(payload)
        payload.extend(raw)
        payload.extend(b"\0" * (-len(payload) % 4))
        return offset

    for name, array in tensors.items():
        if name in QUANTIZED_TENSORS:
            q, scale, _ = quantize_q8(array)
            raw = np.ascontiguousarray(q).tobytes()
            entry = {"shape": list(array.shape), "dtype": "q8", "offset": append(raw), "byteLength": len(raw)}
            scale_raw = np.ascontiguousarray(scale).tobytes()
            entry["scaleOffset"] = append(scale_raw)
            entry["scaleByteLength"] = len(scale_raw)
            entry["scaleDtype"] = "f32"
        else:
            raw = np.ascontiguousarray(array.astype("<f4")).tobytes()
            entry = {"shape": list(array.shape), "dtype": "f32", "offset": append(raw), "byteLength": len(raw)}
        manifest[name] = entry

    header_bytes = pack_header({"dtype": "mixed", "meta": meta, "tensors": manifest})
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<II", 2, len(header_bytes)))
        f.write(header_bytes)
        f.write(payload)
    return 12 + len(header_bytes) + len(payload)


REPO = Path(__file__).parent.parent


@click.command()
@click.option(
    "--out",
    type=click.Path(dir_okay=False, path_type=Path),
    default=REPO / "packages" / "ink-graves" / "assets" / "graves-v2.bin",
    show_default=True,
    help="Shipped asset: q8 weights + baked primed states (CALW v2).",
)
@click.option(
    "--f32-out",
    type=click.Path(dir_okay=False, path_type=Path),
    default=REPO / "packages" / "ink-graves" / "test" / "goldens" / "graves-f32.bin",
    show_default=True,
    help="Reference fixture: f32 weights + style strokes (CALW v1, gitignored).",
)
@click.option(
    "--fixture-only",
    is_flag=True,
    help="Write only the f32 fixture; leave the committed asset untouched (CI).",
)
def main(out: Path, f32_out: Path, fixture_only: bool) -> None:
    data_dir = files("graves_handwriting_mlx") / "data"
    weights = np.load(str(data_dir / "weights.npz"))
    model_tensors: dict[str, np.ndarray] = {name: weights[name].astype("<f4") for name in MODEL_TENSORS}
    alphabet = load_alphabet()
    styles = load_styles(data_dir / "styles")

    base_meta = {
        "model": "graves-2013-rnn",
        "source": "sjvasquez/handwriting-synthesis checkpoint via breitburg/graves-handwriting-mlx",
        "alphabet": alphabet,
        "maxCharLen": 75,
    }

    # Reference fixture: exactly the historical v1 layout, stroke tensors included.
    v1_tensors = dict(model_tensors)
    for style in styles:
        v1_tensors[f"style_{style['id']}"] = style["strokes"].astype("<f4")
    v1_meta = dict(base_meta)
    v1_meta["styles"] = [{"id": s["id"], "primer": s["primer"], "tensor": f"style_{s['id']}"} for s in styles]
    size = write_v1(f32_out, v1_meta, v1_tensors)
    click.echo(f"wrote {f32_out} ({size / 1e6:.1f} MB, {len(v1_tensors)} tensors, f32 reference)")
    if fixture_only:
        return

    # Shipped asset: bake primed states against the weights the file ships
    # (the dequantized q8 values), so restore-and-continue is coherent.
    dequant = {
        name: (quantize_q8(array)[2] if name in QUANTIZED_TENSORS else array)
        for name, array in model_tensors.items()
    }
    v2_tensors = dict(model_tensors)
    for style in styles:
        state = bake_primed_state(dequant, alphabet, style)
        v2_tensors[f"primed_{style['id']}"] = state
        kappa_peak = state[6 * HIDDEN : 6 * HIDDEN + ATTENTION_MIXTURES].max()
        click.echo(f"  baked primed_{style['id']} ({style['strokes'].shape[0]} steps, kappa peak {kappa_peak:.1f})")
    v2_meta = dict(base_meta)
    v2_meta["styles"] = [{"id": s["id"], "primer": s["primer"], "primed": f"primed_{s['id']}"} for s in styles]
    size = write_v2(out, v2_meta, v2_tensors)
    click.echo(f"wrote {out} ({size / 1e6:.1f} MB, {len(v2_tensors)} tensors, q8 + baked priming)")


if __name__ == "__main__":
    main()
