import InkGraves
import SwiftUI

struct ContentView: View {
    private enum Status {
        case loading
        case ready
        case writing
        case failed(String)
    }

    private let engine = InkEngine()
    @State private var text = "a line of ink"
    @State private var strokes: [InkStroke] = []
    @State private var status = Status.loading

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
                Button("Write", action: write)
                    .buttonStyle(.borderedProminent)
                    .disabled(!canWrite)
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
                        InkCanvas(strokes: strokes)
                            .padding(24)
                            .opacity({ if case .writing = status { 0.4 } else { 1 } }())
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding()
        .frame(minWidth: 480, minHeight: 320)
        .task {
            do {
                try await engine.prepare()
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
                strokes = try await engine.write(input, bias: 0.75, seed: .random(in: .min ... .max))
                status = .ready
            } catch {
                status = .failed(String(describing: error))
            }
        }
    }
}

/// Draws a generated line scaled to fit, preserving aspect ratio.
private struct InkCanvas: View {
    let strokes: [InkStroke]

    var body: some View {
        Canvas { context, size in
            guard let bounds = lineBounds(strokes) else { return }
            let scale = min(
                size.width / max(bounds.width, 1),
                size.height / max(bounds.height, 1),
                4
            )
            let offsetX = (size.width - bounds.width * scale) / 2 - bounds.minX * scale
            let offsetY = (size.height - bounds.height * scale) / 2 - bounds.minY * scale
            var path = Path()
            for stroke in strokes {
                guard let first = stroke.points.first else { continue }
                path.move(to: CGPoint(x: first.x * scale + offsetX, y: first.y * scale + offsetY))
                for point in stroke.points.dropFirst() {
                    path.addLine(to: CGPoint(x: point.x * scale + offsetX, y: point.y * scale + offsetY))
                }
            }
            context.stroke(
                path,
                with: .color(.primary),
                style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
            )
        }
    }
}

#Preview {
    ContentView()
}
