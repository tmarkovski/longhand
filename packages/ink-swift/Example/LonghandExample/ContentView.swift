import InkCore
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
                        InkCanvas(strokes: strokes, penStart: penStart, penDone: penDone)
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
private struct InkCanvas: View {
    let strokes: [InkStroke]
    let penStart: Date
    let penDone: Bool

    static let secondsPerStep = 0.008

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: penDone)) { context in
            Canvas { graphics, size in
                guard let bounds = lineBounds(strokes) else { return }
                let scale = min(
                    size.width / max(bounds.width, 1),
                    size.height / max(bounds.height, 1),
                    4
                )
                let offsetX = (size.width - bounds.width * scale) / 2 - bounds.minX * scale
                let offsetY = (size.height - bounds.height * scale) / 2 - bounds.minY * scale
                let place = { (point: SIMD2<Double>) in
                    CGPoint(x: point.x * scale + offsetX, y: point.y * scale + offsetY)
                }

                let revealed = penDone
                    ? Int.max
                    : Int(context.date.timeIntervalSince(penStart) / Self.secondsPerStep)
                var remaining = revealed
                var path = Path()
                var touchdowns: [CGPoint] = []
                for stroke in strokes {
                    guard remaining > 0, let first = stroke.points.first else { break }
                    let visible = min(stroke.points.count, remaining)
                    remaining -= visible
                    if visible == 1 {
                        // A zero-length subpath draws nothing, so the pen's
                        // touchdown shows as a dot until the stroke grows.
                        touchdowns.append(place(first))
                        continue
                    }
                    path.move(to: place(first))
                    for point in stroke.points[1 ..< visible] {
                        path.addLine(to: place(point))
                    }
                }
                graphics.stroke(
                    path,
                    with: .color(.primary),
                    style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
                )
                for dot in touchdowns {
                    graphics.fill(
                        Path(ellipseIn: CGRect(x: dot.x - 1, y: dot.y - 1, width: 2, height: 2)),
                        with: .color(.primary)
                    )
                }
            }
        }
    }
}

#Preview {
    ContentView()
}
