/// Self-contained animated SVG, ported from
/// packages/ink-render/src/animate.ts: the line draws itself in pen time,
/// holds, and loops. Pure SMIL — no scripts — so the file animates
/// anywhere an SVG renders live (inline, <img>, README embeds).
///
/// Points are one model timestep apart, so a point's global index *is* its
/// pen time; every element animates over one shared cycle with keyTimes
/// marking its window.
///
/// The pen look reveals its constant-width runs directly with the classic
/// stroke-dashoffset trick (touchdown dots pop in via discrete opacity).
/// The ribbon look is filled outlines, which dashes can't reveal, so each
/// stroke hides behind a mask whose white stroke traces the centerline —
/// sized from the ribbon's real extent — and the mask's dash animates.

import Foundation
import InkCore

public struct AnimatedSvgOptions: Sendable {
    public var line: LineSvgOptions
    /// Milliseconds of animation per model timestep (pen pace).
    public var msPerStep: Double
    /// Beat before the pen touches down.
    public var leadMs: Double
    /// Hold on the finished line before looping.
    public var holdMs: Double
    /// Loop forever (default) or play once and freeze.
    public var loop: Bool

    public init(
        line: LineSvgOptions,
        msPerStep: Double,
        leadMs: Double = 350,
        holdMs: Double = 1600,
        loop: Bool = true
    ) {
        self.line = line
        self.msPerStep = msPerStep
        self.leadMs = leadMs
        self.holdMs = holdMs
        self.loop = loop
    }
}

/// toFixed(1)-style rounding with trailing-zero stripping ("3", "2.5").
private func fmt(_ value: Double) -> String {
    let text = String(format: "%.1f", value)
    return text.hasSuffix(".0") ? String(text.dropLast(2)) : text
}

/// toFixed(5)-style rounding with trailing-zero stripping ("0.00001").
private func fmtTime(_ value: Double) -> String {
    var text = String(format: "%.5f", value)
    while text.hasSuffix("0") { text.removeLast() }
    if text.hasSuffix(".") { text.removeLast() }
    return text
}

public func lineToAnimatedSvg(_ strokes: [InkStroke], options: AnimatedSvgOptions) -> String {
    let lineOptions = options.line
    let layout = layoutLine(strokes, scale: lineOptions.scale, padding: lineOptions.padding)

    let totalPoints = layout.placed.reduce(0) { $0 + $1.points.count }
    let cycleMs = options.leadMs + Double(totalPoints) * options.msPerStep + options.holdMs
    // A keyTime per point, clamped off the exact endpoints so every list
    // can start at 0 and end at 1.
    func timeOf(_ index: Int) -> Double {
        min(max((options.leadMs + Double(index) * options.msPerStep) / cycleMs, 0.00001), 0.99999)
    }
    let timing = options.loop ? "repeatCount=\"indefinite\"" : "repeatCount=\"1\" fill=\"freeze\""

    func animateOffset(_ values: [Double], _ keyTimes: [Double]) -> String {
        "<animate attributeName=\"stroke-dashoffset\" dur=\"\(fmt(cycleMs))ms\" \(timing) "
            + "values=\"\(values.map(fmt).joined(separator: ";"))\" "
            + "keyTimes=\"\(keyTimes.map(fmtTime).joined(separator: ";"))\"/>"
    }

    let ribbon = lineOptions.renderer == .ribbon
    let parts = ribbon
        ? ribbonAnimatedParts(
            layout, scale: lineOptions.scale, ribbonWidth: lineOptions.ribbonWidth,
            timeOf: timeOf, animateOffset: animateOffset
        )
        : penAnimatedParts(
            layout.placed, pen: lineOptions.pen, widthStep: lineOptions.widthStep,
            ink: lineOptions.ink, cycleMs: cycleMs, timing: timing,
            timeOf: timeOf, animateOffset: animateOffset
        )

    let paint = ribbon
        ? "fill=\"\(lineOptions.ink)\" stroke=\"none\""
        : "fill=\"none\" stroke=\"\(lineOptions.ink)\" stroke-linecap=\"round\" stroke-linejoin=\"round\""
    let backdrop = lineOptions.background.map {
        "<rect width=\"100%\" height=\"100%\" fill=\"\($0)\"/>\n"
    } ?? ""

    return "<svg xmlns=\"http://www.w3.org/2000/svg\" "
        + "viewBox=\"0 0 \(String(format: "%.1f", layout.width)) \(String(format: "%.1f", layout.height))\" "
        + "\(paint) role=\"img\">\n"
        + backdrop
        + parts.joined(separator: "\n")
        + "\n</svg>\n"
}

private func penAnimatedParts(
    _ placed: [InkStroke],
    pen: PenWidthOptions,
    widthStep: Double,
    ink: String,
    cycleMs: Double,
    timing: String,
    timeOf: (Int) -> Double,
    animateOffset: ([Double], [Double]) -> String
) -> [String] {
    var parts: [String] = []
    for stroke in penStrokes(placed, pen: pen, widthStep: widthStep) {
        let (x, y, r, index) = stroke.touchdown
        parts.append(
            "<circle cx=\"\(fmt(x))\" cy=\"\(fmt(y))\" r=\"\(String(format: "%.2f", r))\" "
            + "fill=\"\(ink)\" stroke=\"none\" opacity=\"0\">"
            + "<animate attributeName=\"opacity\" dur=\"\(fmt(cycleMs))ms\" \(timing) calcMode=\"discrete\" "
            + "values=\"0;1;1\" keyTimes=\"0;\(fmtTime(timeOf(index)));1\"/></circle>"
        )
        for run in stroke.runs {
            // Dash slack over the measured length hides coordinate-rounding
            // drift; the offset animates to exactly 0, so the run still
            // reveals in full.
            let dash = run.length * 1.02 + 0.5
            let d = run.points.map { "\(fmt($0.x)) \(fmt($0.y))" }.joined(separator: " L ")
            parts.append(
                "<path d=\"M \(d)\" stroke-width=\"\(String(format: "%.2f", run.width))\" "
                + "stroke-dasharray=\"\(fmt(dash))\" stroke-dashoffset=\"\(fmt(dash))\">"
                + animateOffset(
                    [dash, dash, 0, 0],
                    [0, timeOf(run.startIndex), timeOf(run.endIndex), 1]
                )
                + "</path>"
            )
        }
    }
    return parts
}

private func ribbonAnimatedParts(
    _ layout: LineLayout,
    scale: Double,
    ribbonWidth: Double,
    timeOf: (Int) -> Double,
    animateOffset: ([Double], [Double]) -> String
) -> [String] {
    var parts: [String] = []
    var globalIndex = 0
    for (strokeIndex, stroke) in layout.placed.enumerated() {
        let points = stroke.points
        let startIndex = globalIndex
        globalIndex += points.count
        guard
            let d = ribbonPath(points, scale: scale, width: ribbonWidth),
            let edges = ribbonOutline(points, scale: scale, width: ribbonWidth)
        else { continue }

        // The mask stroke must cover the ribbon wherever the pen has
        // passed: width from the ribbon's widest point (plus slack for the
        // outline's soft cubic overshoot), dash length from the centerline.
        var maskWidth = 0.0
        var cumulative = [0.0]
        for i in 0 ..< points.count {
            let across = edges.top[i] - edges.bottom[i]
            maskWidth = max(maskWidth, hypot(across.x, across.y))
            if i > 0 {
                let segment = points[i] - points[i - 1]
                cumulative.append(cumulative[i - 1] + hypot(segment.x, segment.y))
            }
        }
        maskWidth = maskWidth * 1.3 + 2
        let length = cumulative[points.count - 1]
        let dash = length * 1.02 + maskWidth
        // Resting a full mask-width past "nothing revealed" keeps the dash
        // edge's round cap from peeking out before the stroke starts.
        let hidden = dash + maskWidth

        // Offset keyframes sampled along the stroke, so the reveal follows
        // the pen's real pace (slow in curves, quick on links between
        // letters).
        let step = max(2, Int((Double(points.count) / 32).rounded()))
        var values = [hidden, hidden]
        var keyTimes = [0.0, timeOf(startIndex)]
        var i = step
        while i < points.count - 1 {
            values.append(dash - cumulative[i])
            keyTimes.append(timeOf(startIndex + i))
            i += step
        }
        values.append(contentsOf: [dash - length, dash - length])
        keyTimes.append(contentsOf: [timeOf(startIndex + points.count - 1), 1])

        let centerline = points.map { "\(fmt($0.x)) \(fmt($0.y))" }.joined(separator: " L ")
        parts.append(
            "<mask id=\"reveal\(strokeIndex)\" maskUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" "
            + "width=\"\(String(format: "%.1f", layout.width))\" height=\"\(String(format: "%.1f", layout.height))\">"
            + "<path d=\"M \(centerline)\" fill=\"none\" stroke=\"#fff\" stroke-width=\"\(fmt(maskWidth))\" "
            + "stroke-linecap=\"round\" stroke-linejoin=\"round\" "
            + "stroke-dasharray=\"\(fmt(dash))\" stroke-dashoffset=\"\(fmt(hidden))\">"
            + animateOffset(values, keyTimes)
            + "</path></mask>"
        )
        parts.append("<path d=\"\(d)\" mask=\"url(#reveal\(strokeIndex))\"/>")
    }
    return parts
}
