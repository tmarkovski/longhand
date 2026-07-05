import InkCore
import InkRender
import SwiftUI

struct ContentView: View {
    private enum Status {
        case loading
        case ready
        case writing
        case failed(String)
    }

    private let ink = InkEngine()
    @State private var text = "a line of ink"
    @State private var strokes: [InkStroke] = []
    @State private var status = Status.loading

    @State private var engine = Engine.calligrapher
    // nil is the engine's unstyled mode: random for calligrapher, freehand
    // for longhand, like the web app.
    @State private var style: Int? = nil
    @State private var styleIds: [Int] = []

    // Replay clock: the canvas reveals points at web-parity pen pace from
    // penStart; penDone pauses the timeline once the line is fully drawn.
    @State private var penStart = Date.distantPast
    @State private var penDone = true
    @State private var holdTask: Task<Void, Never>?

    private var canWrite: Bool {
        if case .ready = status { return !text.isEmpty }
        return false
    }

    var body: some View {
        VStack(spacing: 16) {
            HStack(spacing: 8) {
                TextField("type something to write…", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .onSubmit(write)
                Picker("engine", selection: $engine) {
                    ForEach(Engine.allCases) { engine in
                        Text(engine.rawValue).tag(engine)
                    }
                }
                .labelsHidden()
                .fixedSize()
                Picker("style", selection: $style) {
                    Text(engine.defaultStyleName).tag(Int?.none)
                    ForEach(styleIds, id: \.self) { id in
                        Text("style \(id)").tag(Int?.some(id))
                    }
                }
                .labelsHidden()
                .fixedSize()
                Button("Write", action: write)
                    .buttonStyle(.borderedProminent)
                    .disabled(!canWrite)
                Button("Replay", action: replay)
                    .disabled(strokes.isEmpty || !canWrite)
            }
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(.background)
                    .shadow(color: .black.opacity(0.1), radius: 6, y: 2)
                switch status {
                case .loading:
                    ProgressView("loading model…")
                case .failed(let message):
                    Text(message)
                        .foregroundStyle(.red)
                        .padding()
                case .ready, .writing:
                    if strokes.isEmpty {
                        Text("press write")
                            .foregroundStyle(.secondary)
                    } else {
                        InkCanvas(
                            strokes: strokes,
                            renderer: engine.renderer,
                            penStart: penStart,
                            penDone: penDone
                        )
                        .padding(24)
                        .opacity({ if case .writing = status { 0.4 } else { 1 } }())
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding()
        .frame(minWidth: 560, minHeight: 320)
        .task(id: engine) {
            status = .loading
            style = nil
            do {
                styleIds = try await ink.prepare(engine)
                status = .ready
            } catch {
                status = .failed(String(describing: error))
            }
        }
    }

    private func write() {
        guard canWrite else { return }
        status = .writing
        let input = text
        Task {
            do {
                strokes = try await ink.write(engine, text: input, bias: 0.75, style: style, seed: .random(in: .min ... .max))
                status = .ready
                replay()
            } catch {
                status = .failed(String(describing: error))
            }
        }
    }

    /// Rewind the pen and let the timeline draw the line again.
    private func replay() {
        penStart = .now
        penDone = false
        holdTask?.cancel()
        let drawSeconds = Double(strokes.reduce(0) { $0 + $1.points.count }) * InkCanvas.secondsPerStep
        holdTask = Task {
            try? await Task.sleep(for: .seconds(drawSeconds + 0.25))
            if !Task.isCancelled { penDone = true }
        }
    }
}

/// Draws a generated line scaled to fit, revealing it in pen time: points
/// are one model timestep apart, and each timestep gets `secondsPerStep`
/// of animation, matching the web app's canvas replay (DT_MS = 8).
///
/// Each renderer is the engine's tuned ink look from InkRender: "ribbon"
/// fills speed-shaped outline polygons (ink pools where the pen is slow),
/// "pen" strokes width-bucketed runs from speed-based pen widths.
private struct InkCanvas: View {
    let strokes: [InkStroke]
    let renderer: InkRenderer
    let penStart: Date
    let penDone: Bool

    static let secondsPerStep = 0.008
    /// The web app's calligrapher ribbon weight: 2× the reference width.
    private static let ribbonInkWidth = ribbonWidthDefault * 2
    /// The web app's pen weight per unit of layout scale.
    private static let penWidthPerScale = 2.2 / 1.6

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: penDone)) { context in
            Canvas { graphics, size in
                guard let bounds = lineBounds(strokes) else { return }
                let scale = min(
                    size.width / max(bounds.width, 1),
                    size.height / max(bounds.height, 1),
                    4
                )
                let placed = transformLine(
                    strokes,
                    scale: scale,
                    translateX: (size.width - bounds.width * scale) / 2 - bounds.minX * scale,
                    translateY: (size.height - bounds.height * scale) / 2 - bounds.minY * scale
                )
                let revealed = penDone
                    ? Int.max
                    : Int(context.date.timeIntervalSince(penStart) / Self.secondsPerStep)
                switch renderer {
                case .ribbon:
                    drawRibbons(placed, scale: scale, revealed: revealed, in: &graphics)
                case .pen:
                    drawPen(placed, scale: scale, revealed: revealed, in: &graphics)
                }
            }
        }
    }

    private func drawRibbons(
        _ placed: [InkStroke], scale: Double, revealed: Int, in graphics: inout GraphicsContext
    ) {
        var remaining = revealed
        for stroke in placed {
            guard remaining > 0, let first = stroke.points.first else { break }
            let visible = min(stroke.points.count, remaining)
            remaining -= visible
            let prefix = Array(stroke.points.prefix(visible))
            guard let outline = ribbonOutline(prefix, scale: scale, width: Self.ribbonInkWidth) else {
                // Touchdown dot until the stroke grows a second point.
                graphics.fill(
                    Path(ellipseIn: CGRect(x: first.x - 1.2, y: first.y - 1.2, width: 2.4, height: 2.4)),
                    with: .color(.primary)
                )
                continue
            }
            let (start, segments) = ribbonSegments(outline)
            var path = Path()
            path.move(to: CGPoint(x: start.x, y: start.y))
            for segment in segments {
                path.addCurve(
                    to: CGPoint(x: segment.end.x, y: segment.end.y),
                    control1: CGPoint(x: segment.control1.x, y: segment.control1.y),
                    control2: CGPoint(x: segment.control2.x, y: segment.control2.y)
                )
            }
            path.closeSubpath()
            graphics.fill(path, with: .color(.primary))
        }
    }

    private func drawPen(
        _ placed: [InkStroke], scale: Double, revealed: Int, in graphics: inout GraphicsContext
    ) {
        let pen = PenWidthOptions(base: Self.penWidthPerScale * scale)
        for stroke in penStrokes(placed, pen: pen) {
            let (x, y, r, index) = stroke.touchdown
            guard index < revealed else { break }
            graphics.fill(
                Path(ellipseIn: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r)),
                with: .color(.primary)
            )
            for run in stroke.runs {
                let visible = min(run.points.count, revealed - run.startIndex)
                guard visible > 1 else { continue }
                var path = Path()
                path.move(to: CGPoint(x: run.points[0].x, y: run.points[0].y))
                for point in run.points[1 ..< visible] {
                    path.addLine(to: CGPoint(x: point.x, y: point.y))
                }
                graphics.stroke(
                    path,
                    with: .color(.primary),
                    style: StrokeStyle(lineWidth: run.width, lineCap: .round, lineJoin: .round)
                )
            }
        }
    }
}

#Preview {
    ContentView()
}
