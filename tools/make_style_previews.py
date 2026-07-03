"""Render one static SVG per handwriting style for the app's style dropdown.

Generates the same phrase in every bundled style (plus the model's freehand)
so the picker can show each style's actual hand. No animation: each file is
the finished ink, tightly cropped to its bounding box with a transparent
background, stroke color `currentColor` so the consuming CSS controls ink.

Reuses the MLX reference's stroke post-processing (`offsets_to_coords`,
`_denoise`, `_align`) so a preview matches what the engine actually draws.
"""

from __future__ import annotations

from pathlib import Path

import click
import numpy as np

from graves_handwriting_mlx.draw import _align, _denoise, offsets_to_coords
from graves_handwriting_mlx.hand import Hand

# App defaults (apps/web/src/App.tsx): same phrase, bias, seed, scale, ink.
DEFAULT_TEXT = "a line of ink, thinking as it goes"
DEFAULT_BIAS = 0.75
DEFAULT_SEED = 42
SCALE = 1.6          # App.tsx SCALE
STROKE_WIDTH = 2.1   # App.tsx canvas lineWidth
PADDING = 6          # svg-unit margin around the ink
NUM_STYLES = 13


def _processed_coords(offsets: np.ndarray) -> np.ndarray:
    """Model offsets -> deskewed, denoised, y-down absolute coordinates."""
    offsets = np.array(offsets, dtype=np.float64).copy()
    offsets[:, :2] *= SCALE
    coords = offsets_to_coords(offsets)
    coords = _denoise(coords)
    coords[:, :2] = _align(coords[:, :2])
    coords[:, 1] *= -1  # svg y grows downward
    return coords


def render_preview(offsets: np.ndarray) -> str:
    """Tightly-cropped, transparent, single-path SVG for one line of ink."""
    coords = _processed_coords(offsets)
    xy = coords[:, :2]
    xy = xy - xy.min(axis=0) + PADDING
    width = float(xy[:, 0].max()) + PADDING
    height = float(xy[:, 1].max()) + PADDING

    segments: list[str] = []
    previous_eos = 1.0
    for (x, y), eos in zip(xy, coords[:, 2]):
        command = "M" if previous_eos == 1.0 else "L"
        segments.append(f"{command}{x:.2f},{y:.2f}")
        previous_eos = eos
    path = " ".join(segments)

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.2f} {height:.2f}" '
        f'fill="none" stroke="currentColor" stroke-width="{STROKE_WIDTH}" '
        f'stroke-linecap="round" stroke-linejoin="round" role="img">'
        f'<path d="{path}"/></svg>\n'
    )


@click.command()
@click.option("--text", default=DEFAULT_TEXT, show_default=True, help="Phrase to write in each style.")
@click.option("--bias", default=DEFAULT_BIAS, show_default=True, help="Legibility (higher = steadier).")
@click.option("--seed", default=DEFAULT_SEED, show_default=True)
@click.option(
    "--out-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=Path(__file__).parent.parent / "apps" / "web" / "public" / "styles",
    show_default=True,
)
def main(text: str, bias: float, seed: int, out_dir: Path) -> None:
    hand = Hand()
    out_dir.mkdir(parents=True, exist_ok=True)

    # (filename, style id or None for freehand)
    jobs: list[tuple[str, int | None]] = [("freehand", None)]
    jobs += [(f"style-{i}", i) for i in range(NUM_STYLES)]

    for name, style_id in jobs:
        styles = None if style_id is None else [style_id]
        strokes = hand.write([text], biases=[bias], styles=styles, seed=seed)[0]
        path = out_dir / f"{name}.svg"
        path.write_text(render_preview(strokes))
        click.echo(f"wrote {path} ({len(strokes)} steps)")


if __name__ == "__main__":
    main()
