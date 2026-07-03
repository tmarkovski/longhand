"""Record golden test vectors from the MLX reference implementation.

Runs the HandwritingCell teacher-forced (no sampling, so no RNG involvement)
over a fixed input stroke sequence and records, per step:

  - kappa (attention mixture centers, 10)
  - phi argmax + the full phi row (attention over 120 char positions)
  - window (73)
  - MDN params after bias sharpening: pi, muX, muY, sigmaX, sigmaY, rho (20 each), eos

The TypeScript engine must reproduce these within tolerance. Sampling is
excluded on purpose: the two engines use different RNGs, and everything
upstream of sampling is deterministic.
"""

from __future__ import annotations

import json
from importlib.resources import files
from pathlib import Path

import click
import mlx.core as mx
import numpy as np

from graves_handwriting_mlx.alphabet import encode_ascii
from graves_handwriting_mlx.hand import load_style
from graves_handwriting_mlx.model import ALPHABET_SIZE, HandwritingCell
from graves_handwriting_mlx.weights import load_weights

MAX_CHARS = 120


def run_case(cell: HandwritingCell, name: str, chars_text: str, bias: float, forced_inputs: np.ndarray) -> dict:
    encoded = encode_ascii(chars_text)
    char_len = len(encoded)
    chars = np.zeros((1, MAX_CHARS), dtype=np.int32)
    chars[0, : len(encoded)] = encoded

    chars_onehot = mx.take(mx.eye(ALPHABET_SIZE, dtype=mx.float32), mx.array(chars), axis=0)
    char_positions = mx.arange(MAX_CHARS, dtype=mx.float32).reshape(1, 1, MAX_CHARS)
    mask = (np.arange(MAX_CHARS) < char_len).astype(np.float32).reshape(1, MAX_CHARS, 1)
    char_mask = mx.array(mask)
    bias_mx = mx.array(np.array([bias], dtype=np.float32))

    state = cell.initial_state(1, MAX_CHARS)
    steps = []
    for t in range(forced_inputs.shape[0]):
        inputs = mx.array(forced_inputs[t : t + 1].astype(np.float32))
        state = cell.step(state, inputs, chars_onehot, char_positions, char_mask)
        pi, mu_x, mu_y, sigma_x, sigma_y, rho, eos = cell.head.parse(state[4], bias_mx)
        mx.eval(state, pi, mu_x, mu_y, sigma_x, sigma_y, rho, eos)

        phi = np.array(state[8])[0]
        steps.append(
            {
                "kappa": np.array(state[6])[0].tolist(),
                "phi": phi.tolist(),
                "phiArgmax": int(phi.argmax()),
                "window": np.array(state[7])[0].tolist(),
                "pi": np.array(pi)[0].tolist(),
                "muX": np.array(mu_x)[0].tolist(),
                "muY": np.array(mu_y)[0].tolist(),
                "sigmaX": np.array(sigma_x)[0].tolist(),
                "sigmaY": np.array(sigma_y)[0].tolist(),
                "rho": np.array(rho)[0].tolist(),
                "eos": float(np.array(eos)[0, 0]),
            }
        )

    return {
        "name": name,
        "charsText": chars_text,
        "encoded": encoded.tolist(),
        "charLen": char_len,
        "bias": bias,
        "inputs": forced_inputs.tolist(),
        "steps": steps,
    }


@click.command()
@click.option(
    "--out-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=Path(__file__).parent.parent / "packages" / "ink-graves" / "test" / "goldens",
    show_default=True,
)
@click.option("--steps", "num_steps", default=120, show_default=True)
@click.option("--cpu", is_flag=True, help="Force the MLX CPU device (for CI runners without Metal).")
def main(out_dir: Path, num_steps: int, cpu: bool) -> None:
    if cpu:
        mx.set_default_device(mx.cpu)
    cell = HandwritingCell(load_weights())
    out_dir.mkdir(parents=True, exist_ok=True)

    style0_strokes, style0_primer = load_style(0)
    style9_strokes, style9_primer = load_style(9)

    # Case 1: unprimed text, forced inputs taken from real pen data (style 0).
    # First input row is the conventional start token [0, 0, 1].
    inputs_1 = np.vstack([[[0.0, 0.0, 1.0]], style0_strokes[: num_steps - 1]])
    case_1 = run_case(cell, "unprimed-bias075", "hello world", 0.75, inputs_1)

    # Case 2: primed-style char layout (primer + " " + text) at a different
    # bias, forced with style 9's own pen data.
    inputs_2 = np.vstack([[[0.0, 0.0, 1.0]], style9_strokes[: num_steps - 1]])
    case_2 = run_case(cell, "primed9-bias10", style9_primer + " " + "hello", 1.0, inputs_2)

    for case in (case_1, case_2):
        path = out_dir / f"{case['name']}.json"
        with open(path, "w") as f:
            json.dump(case, f)
        click.echo(f"wrote {path} ({len(case['steps'])} steps)")


if __name__ == "__main__":
    main()
