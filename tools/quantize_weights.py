"""Quantization experiment for the Graves model container (size study only).

Reads the shipped CALW v1 float32 container and emits, per scheme, two
files:

  graves-v1-<scheme>.bin       compact artifact ("CALW" version 2, mixed
                               dtypes) — the thing whose size we care about
  graves-v1-<scheme>-sim.bin   the same weights dequantized back to float32
                               in a standard CALW v1 container, so the
                               unmodified TS engine can run the quantized
                               model for A/B comparison

Schemes (weight matrices only; biases and style stroke data stay f32 —
they are ~130 KB of the 14.6 MB and the styles are input data, not
weights):

  f16   every 2-D weight matrix as IEEE half precision
  q8    int8 with a per-output-column float32 scale (symmetric absmax)
  q4    LSTM kernels as int4 (two per byte) with float16 scales per
        64-row group per column; the small attention/GMM heads stay int8

The v2 container is self-describing: each tensor entry carries its dtype
and, for quantized tensors, where its scales live and the group size. No
runtime consumes v2 yet — this tool is the experiment.
"""

from __future__ import annotations

import gzip
import json
import struct
from pathlib import Path

import click
import numpy as np

MAGIC = b"CALW"

LSTM_KERNELS = ["lstm1_kernel", "lstm2_kernel", "lstm3_kernel"]
HEAD_MATRICES = ["attention_weights", "gmm_weights"]
Q4_GROUP = 64


def read_calw_v1(path: Path) -> tuple[dict, dict[str, np.ndarray]]:
    blob = path.read_bytes()
    if blob[:4] != MAGIC:
        raise click.ClickException(f"{path} is not a CALW container")
    version, header_len = struct.unpack_from("<II", blob, 4)
    if version != 1:
        raise click.ClickException(f"expected CALW v1, got v{version}")
    header = json.loads(blob[12 : 12 + header_len])
    data_start = 12 + header_len
    tensors = {}
    for name, entry in header["tensors"].items():
        count = int(np.prod(entry["shape"]))
        array = np.frombuffer(blob, dtype="<f4", count=count, offset=data_start + entry["offset"])
        tensors[name] = array.reshape(entry["shape"]).copy()
    return header, tensors


def quantize_f16(w: np.ndarray) -> tuple[dict[str, np.ndarray], np.ndarray]:
    stored = w.astype("<f2")
    return {"data": stored}, stored.astype("<f4")


def quantize_q8(w: np.ndarray) -> tuple[dict[str, np.ndarray], np.ndarray]:
    scale = np.abs(w).max(axis=0) / 127.0
    scale[scale == 0] = 1.0
    scale = scale.astype("<f4")
    q = np.clip(np.rint(w / scale), -127, 127).astype(np.int8)
    return {"data": q, "scales": scale}, q.astype("<f4") * scale


def quantize_q4(w: np.ndarray, group: int = Q4_GROUP) -> tuple[dict[str, np.ndarray], np.ndarray]:
    rows, cols = w.shape
    ngroups = -(-rows // group)
    padded = np.zeros((ngroups * group, cols), dtype=np.float32)
    padded[:rows] = w
    grouped = padded.reshape(ngroups, group, cols)
    scale = (np.abs(grouped).max(axis=1) / 7.0).astype("<f2")  # (ngroups, cols)
    scale_f4 = scale.astype("<f4")
    scale_f4[scale_f4 == 0] = 1.0
    q = np.clip(np.rint(grouped / scale_f4[:, None, :]), -7, 7).astype(np.int8)
    dequant = (q.astype("<f4") * scale_f4[:, None, :]).reshape(-1, cols)[:rows]
    nibbles = (q + 7).astype(np.uint8).reshape(-1)  # 0..14, padded length is even
    packed = nibbles[0::2] | (nibbles[1::2] << 4)
    return {"data": packed, "scales": scale, "groupSize": group}, np.ascontiguousarray(dequant)


def plan(scheme: str, name: str, w: np.ndarray):
    """Pick the codec for one tensor under a scheme; None = keep f32."""
    is_matrix = name in LSTM_KERNELS or name in HEAD_MATRICES
    if not is_matrix:
        return None
    if scheme == "f16":
        return quantize_f16(w)
    if scheme == "q8":
        return quantize_q8(w)
    if scheme == "q4":
        return quantize_q4(w) if name in LSTM_KERNELS else quantize_q8(w)
    raise click.ClickException(f"unknown scheme {scheme}")


DTYPE_TAGS = {np.dtype("<f2"): "f16", np.dtype(np.int8): "q8", np.dtype(np.uint8): "q4", np.dtype("<f4"): "f32"}


def write_v2(path: Path, meta: dict, scheme: str, entries: list[tuple[str, list[int], dict[str, np.ndarray] | None, np.ndarray]]) -> None:
    payload = bytearray()
    manifest: dict[str, dict] = {}

    def append(raw: bytes) -> int:
        offset = len(payload)
        payload.extend(raw)
        payload.extend(b"\0" * (-len(payload) % 4))
        return offset

    for name, shape, stored, original in entries:
        if stored is None:
            raw = np.ascontiguousarray(original.astype("<f4")).tobytes()
            manifest[name] = {"shape": shape, "dtype": "f32", "offset": append(raw), "byteLength": len(raw)}
            continue
        data = stored["data"]
        raw = np.ascontiguousarray(data).tobytes()
        entry = {"shape": shape, "dtype": DTYPE_TAGS[data.dtype], "offset": append(raw), "byteLength": len(raw)}
        if "scales" in stored:
            scales = np.ascontiguousarray(stored["scales"]).tobytes()
            entry["scaleDtype"] = "f16" if stored["scales"].dtype == np.dtype("<f2") else "f32"
            entry["scaleOffset"] = append(scales)
            entry["scaleByteLength"] = len(scales)
        if "groupSize" in stored:
            entry["groupSize"] = stored["groupSize"]
        manifest[name] = entry

    header = {"dtype": "mixed", "scheme": scheme, "meta": meta, "tensors": manifest}
    header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    header_bytes += b" " * (-len(header_bytes) % 4)
    with open(path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<II", 2, len(header_bytes)))
        f.write(header_bytes)
        f.write(payload)


def write_v1_sim(path: Path, meta: dict, tensors: dict[str, np.ndarray]) -> None:
    manifest: dict[str, dict] = {}
    payload = bytearray()
    for name, array in tensors.items():
        raw = np.ascontiguousarray(array.astype("<f4")).tobytes()
        manifest[name] = {"shape": list(array.shape), "offset": len(payload), "byteLength": len(raw)}
        payload.extend(raw)
    header = {"dtype": "f32", "meta": meta, "tensors": manifest}
    header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    header_bytes += b" " * (-len(header_bytes) % 4)
    with open(path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<II", 1, len(header_bytes)))
        f.write(header_bytes)
        f.write(payload)


def gz_size(path: Path) -> int:
    return len(gzip.compress(path.read_bytes(), compresslevel=9))


@click.command()
@click.option(
    "--weights",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    default=Path(__file__).parent.parent / "packages" / "ink-graves" / "test" / "goldens" / "graves-f32.bin",
    show_default=True,
    help="An f32 CALW v1 container (pnpm gen:weights writes the fixture).",
)
@click.option(
    "--out-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=Path(__file__).parent / "scratch" / "quantized",
    show_default=True,
)
@click.option("--schemes", multiple=True, default=("f16", "q8", "q4"), show_default=True)
def main(weights: Path, out_dir: Path, schemes: tuple[str, ...]) -> None:
    header, tensors = read_calw_v1(weights)
    meta = header["meta"]
    out_dir.mkdir(parents=True, exist_ok=True)

    original_size = weights.stat().st_size
    click.echo(f"original: {original_size / 1e6:.2f} MB raw, {gz_size(weights) / 1e6:.2f} MB gzip -9")

    for scheme in schemes:
        entries = []
        sim_tensors: dict[str, np.ndarray] = {}
        click.echo(f"\n[{scheme}]")
        for name, w in tensors.items():
            coded = plan(scheme, name, w)
            if coded is None:
                entries.append((name, list(w.shape), None, w))
                sim_tensors[name] = w
                continue
            stored, dequant = coded
            entries.append((name, list(w.shape), stored, w))
            sim_tensors[name] = dequant
            err = dequant - w
            snr = 20 * np.log10(np.linalg.norm(w) / max(np.linalg.norm(err), 1e-12))
            click.echo(
                f"  {name:20s} {DTYPE_TAGS[stored['data'].dtype]:>4s}"
                f"  max|err|={np.abs(err).max():.5f}  snr={snr:5.1f} dB"
            )

        artifact = out_dir / f"graves-v1-{scheme}.bin"
        sim = out_dir / f"graves-v1-{scheme}-sim.bin"
        write_v2(artifact, meta, scheme, entries)
        write_v1_sim(sim, meta, sim_tensors)

        raw = artifact.stat().st_size
        click.echo(
            f"  -> {artifact.name}: {raw / 1e6:.2f} MB raw ({original_size / raw:.1f}x smaller), "
            f"{gz_size(artifact) / 1e6:.2f} MB gzip -9; sim {sim.stat().st_size / 1e6:.2f} MB"
        )


if __name__ == "__main__":
    main()
