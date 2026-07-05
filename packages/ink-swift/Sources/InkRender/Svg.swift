/// Standalone SVG documents from ink lines, ported from
/// packages/ink-render/src/svg.ts. One entry point with a renderer switch
/// mirroring the app's pen/ribbon split: "pen" strokes polylines with
/// speed-based widths, "ribbon" fills the calligrapher's outline polygons
/// from `ribbonPath`.
///
/// Output is tightly cropped and, by default, transparent-background
/// `currentColor` ink so the consuming CSS picks the color (when the SVG
/// is inlined; inside an <img> it falls back to black). Exports pass
/// explicit `ink`/`background` so the file looks right anywhere.

import Foundation
import InkCore

/// Which ink look to draw; matches the engine's renderer in the app.
public enum InkRenderer: String, Sendable {
    case pen
    case ribbon
}

public struct LineSvgOptions: Sendable {
    public var renderer: InkRenderer
    /// Model-to-display scale applied while laying out the line.
    public var scale: Double
    /// Whitespace around the ink, in display units.
    public var padding: Double
    /// Ink paint. `currentColor` inherits when inlined.
    public var ink: String
    /// Background paint; nil (transparent) by default.
    public var background: String?
    /// Pen look: pen width options.
    public var pen: PenWidthOptions
    /// Pen look: the run quantization step.
    public var widthStep: Double
    /// Ribbon look: nominal ribbon width.
    public var ribbonWidth: Double

    public init(
        renderer: InkRenderer,
        scale: Double,
        padding: Double = 6,
        ink: String = "currentColor",
        background: String? = nil,
        pen: PenWidthOptions = PenWidthOptions(),
        widthStep: Double = defaultWidthStep,
        ribbonWidth: Double = ribbonWidthDefault
    ) {
        self.renderer = renderer
        self.scale = scale
        self.padding = padding
        self.ink = ink
        self.background = background
        self.pen = pen
        self.widthStep = widthStep
        self.ribbonWidth = ribbonWidth
    }
}

/// A line laid out for serialization: placed ink plus the crop size.
public struct LineLayout: Sendable {
    public let placed: [InkStroke]
    public let width: Double
    public let height: Double
}

/// Lay the line out at `scale`, cropped to the ink plus `padding`.
/// An empty line collapses to a padding-sized empty layout.
public func layoutLine(_ strokes: [InkStroke], scale: Double, padding: Double) -> LineLayout {
    guard let bounds = lineBounds(strokes) else {
        return LineLayout(placed: strokes, width: 2 * padding, height: 2 * padding)
    }
    let placed = transformLine(
        strokes,
        scale: scale,
        translateX: padding - bounds.minX * scale,
        translateY: padding - bounds.minY * scale
    )
    return LineLayout(
        placed: placed,
        width: bounds.width * scale + 2 * padding,
        height: bounds.height * scale + 2 * padding
    )
}

// SVG can't vary width along one path, so pen segments are grouped into
// runs of similar width and each run becomes a path. Coarse enough to keep
// files small, fine enough that the steps are invisible at dropdown size.
public let defaultWidthStep = 0.2

/// One constant-width polyline run, with the point-count timing an
/// animated serialization needs: global point indices are pen time.
public struct PenRun: Sendable {
    public var points: [SIMD2<Double>]
    public var width: Double
    /// Global index (across all strokes) of the run's first point.
    public var startIndex: Int
    /// Global index of the run's last point.
    public var endIndex: Int
    /// Geometric polyline length.
    public var length: Double
}

/// A stroke rendered for SVG: a touchdown dot plus width-bucketed runs.
public struct PenStrokeParts: Sendable {
    public var touchdown: (x: Double, y: Double, r: Double, index: Int)
    public var runs: [PenRun]
}

/// Split each stroke into constant-width runs (shared by the static and
/// animated serializers).
public func penStrokes(
    _ placed: [InkStroke],
    pen: PenWidthOptions = PenWidthOptions(),
    widthStep: Double = defaultWidthStep
) -> [PenStrokeParts] {
    let widths = penWidths(placed, options: pen)

    var globalIndex = 0
    return placed.enumerated().map { strokeIndex, stroke in
        let first = stroke.points[0]
        var parts = PenStrokeParts(
            touchdown: (x: first.x, y: first.y, r: widths[strokeIndex][0] / 2, index: globalIndex),
            runs: []
        )
        var run: [SIMD2<Double>] = []
        var runWidth = 0.0
        var runStart = 0
        var runLength = 0.0
        func flush(_ endIndex: Int) {
            if run.count > 1 {
                parts.runs.append(PenRun(
                    points: run,
                    width: runWidth,
                    startIndex: runStart,
                    endIndex: endIndex,
                    length: runLength
                ))
            }
            run = []
            runLength = 0
        }
        for i in 1 ..< stroke.points.count {
            let here = stroke.points[i]
            let previous = stroke.points[i - 1]
            let segment = (widths[strokeIndex][i - 1] + widths[strokeIndex][i]) / 2
            let bucket = max(widthStep, (segment / widthStep).rounded() * widthStep)
            if run.isEmpty || bucket != runWidth {
                flush(globalIndex + i - 1)
                run.append(previous)
                runWidth = bucket
                runStart = globalIndex + i - 1
            }
            run.append(here)
            runLength += hypot(here.x - previous.x, here.y - previous.y)
        }
        flush(globalIndex + stroke.points.count - 1)
        globalIndex += stroke.points.count
        return parts
    }
}

/// Serialize one line into a self-contained SVG document, laid out at
/// `scale` and cropped to the ink plus `padding`.
public func lineToSvg(_ strokes: [InkStroke], options: LineSvgOptions) -> String {
    let layout = layoutLine(strokes, scale: options.scale, padding: options.padding)

    let ribbon = options.renderer == .ribbon
    let parts = ribbon
        ? ribbonParts(layout.placed, scale: options.scale, width: options.ribbonWidth)
        : penPartStrings(
            penStrokes(layout.placed, pen: options.pen, widthStep: options.widthStep),
            ink: options.ink
        )
    // Ribbons are filled outlines; pen runs are stroked centerlines.
    let paint = ribbon
        ? "fill=\"\(options.ink)\" stroke=\"none\""
        : "fill=\"none\" stroke=\"\(options.ink)\" stroke-linecap=\"round\" stroke-linejoin=\"round\""
    let backdrop = options.background.map {
        "<rect width=\"100%\" height=\"100%\" fill=\"\($0)\"/>\n"
    } ?? ""

    return "<svg xmlns=\"http://www.w3.org/2000/svg\" "
        + "viewBox=\"0 0 \(String(format: "%.1f", layout.width)) \(String(format: "%.1f", layout.height))\" "
        + "\(paint) role=\"img\">\n"
        + backdrop
        + parts.joined(separator: "\n")
        + "\n</svg>\n"
}

/// Static markup for pen strokes: a dot and a path per run.
private func penPartStrings(_ strokes: [PenStrokeParts], ink: String) -> [String] {
    var parts: [String] = []
    for stroke in strokes {
        let (x, y, r, _) = stroke.touchdown
        parts.append(
            "<circle cx=\"\(String(format: "%.1f", x))\" cy=\"\(String(format: "%.1f", y))\" "
            + "r=\"\(String(format: "%.2f", r))\" fill=\"\(ink)\" stroke=\"none\"/>"
        )
        for run in stroke.runs {
            let d = run.points
                .map { "\(String(format: "%.1f", $0.x)) \(String(format: "%.1f", $0.y))" }
                .joined(separator: " L ")
            parts.append("<path d=\"M \(d)\" stroke-width=\"\(String(format: "%.2f", run.width))\"/>")
        }
    }
    return parts
}

/// One filled outline path per stroke; sub-two-point strokes draw nothing.
private func ribbonParts(_ placed: [InkStroke], scale: Double, width: Double) -> [String] {
    var parts: [String] = []
    for stroke in placed {
        if let d = ribbonPath(stroke.points, scale: scale, width: width) {
            parts.append("<path d=\"\(d)\"/>")
        }
    }
    return parts
}
