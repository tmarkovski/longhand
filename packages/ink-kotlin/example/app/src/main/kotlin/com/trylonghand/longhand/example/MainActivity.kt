package com.trylonghand.longhand.example

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.withFrameNanos
import com.trylonghand.ink.core.InkStroke
import com.trylonghand.ink.core.lineBounds
import com.trylonghand.ink.core.transformLine
import com.trylonghand.ink.render.PenWidthOptions
import com.trylonghand.ink.render.penStrokes
import com.trylonghand.ink.render.ribbonOutline
import com.trylonghand.ink.render.ribbonSegments
import com.trylonghand.ink.render.ribbonWidthDefault
import kotlinx.coroutines.launch
import kotlin.random.Random

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                LonghandScreen()
            }
        }
    }
}

private sealed interface Status {
    data object Loading : Status
    data object Ready : Status
    data object Writing : Status
    data class Failed(val message: String) : Status
}

/** Points are one model timestep apart; each gets 8 ms of animation,
 * matching the web app's canvas replay (DT_MS = 8). */
private const val SECONDS_PER_STEP = 0.008

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LonghandScreen() {
    val ink = remember { InkEngine() }
    val scope = rememberCoroutineScope()

    var text by remember { mutableStateOf("a line of ink") }
    var strokes by remember { mutableStateOf<List<InkStroke>>(emptyList()) }
    var status by remember { mutableStateOf<Status>(Status.Loading) }

    var engine by remember { mutableStateOf(Engine.CALLIGRAPHER) }
    // null is the engine's unstyled mode: random for calligrapher, freehand
    // for longhand, like the web app.
    var style by remember { mutableStateOf<Int?>(null) }
    var styleIds by remember { mutableStateOf<List<Int>>(emptyList()) }

    // Replay clock: the canvas reveals points at web-parity pen pace from
    // penStart; penDone pauses the frame loop once the line is drawn.
    var penStartNanos by remember { mutableLongStateOf(0L) }
    var penDone by remember { mutableStateOf(true) }
    var frameNanos by remember { mutableLongStateOf(0L) }

    val canWrite = status is Status.Ready && text.isNotEmpty()

    LaunchedEffect(engine) {
        status = Status.Loading
        style = null
        try {
            styleIds = ink.prepare(engine)
            status = Status.Ready
        } catch (error: Exception) {
            status = Status.Failed(error.toString())
        }
    }

    // Frame loop, alive only while the pen is moving.
    LaunchedEffect(penDone) {
        while (!penDone) {
            withFrameNanos { frameNanos = it }
            val total = strokes.sumOf { it.points.count() }
            val elapsed = (frameNanos - penStartNanos) / 1_000_000_000.0
            if (elapsed > total * SECONDS_PER_STEP + 0.25) penDone = true
        }
    }

    fun replay() {
        penStartNanos = System.nanoTime()
        frameNanos = penStartNanos
        penDone = false
    }

    fun write() {
        if (!canWrite) return
        status = Status.Writing
        val input = text
        scope.launch {
            try {
                strokes = ink.write(
                    engine,
                    text = input,
                    bias = 0.75,
                    style = style,
                    seed = Random.nextInt().toUInt(),
                )
                status = Status.Ready
                replay()
            } catch (error: Exception) {
                status = Status.Failed(error.toString())
            }
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("type something to write…") },
            singleLine = true,
        )
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            EnginePicker(engine, onPick = { engine = it })
            StylePicker(engine, style, styleIds, onPick = { style = it })
            Button(onClick = ::write, enabled = canWrite) { Text("Write") }
            OutlinedButton(onClick = ::replay, enabled = strokes.isNotEmpty() && canWrite) {
                Text("Replay")
            }
        }
        ElevatedCard(modifier = Modifier.fillMaxSize()) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                when (val current = status) {
                    is Status.Loading -> CircularProgressIndicator()
                    is Status.Failed -> Text(current.message, color = MaterialTheme.colorScheme.error)
                    else ->
                        if (strokes.isEmpty()) {
                            Text("press write", color = MaterialTheme.colorScheme.outline)
                        } else {
                            val revealed = if (penDone) {
                                Int.MAX_VALUE
                            } else {
                                ((frameNanos - penStartNanos) / 1_000_000_000.0 / SECONDS_PER_STEP).toInt()
                            }
                            InkCanvas(
                                strokes = strokes,
                                engine = engine,
                                revealed = revealed,
                                dimmed = status is Status.Writing,
                            )
                        }
                }
            }
        }
    }
}

@Composable
private fun EnginePicker(engine: Engine, onPick: (Engine) -> Unit) {
    var open by remember { mutableStateOf(false) }
    OutlinedButton(onClick = { open = true }) { Text(engine.label) }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        Engine.entries.forEach { candidate ->
            DropdownMenuItem(
                text = { Text(candidate.label) },
                onClick = {
                    open = false
                    onPick(candidate)
                },
            )
        }
    }
}

@Composable
private fun StylePicker(engine: Engine, style: Int?, styleIds: List<Int>, onPick: (Int?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    OutlinedButton(onClick = { open = true }) {
        Text(style?.let { "style $it" } ?: engine.defaultStyleName)
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        DropdownMenuItem(
            text = { Text(engine.defaultStyleName) },
            onClick = {
                open = false
                onPick(null)
            },
        )
        styleIds.forEach { id ->
            DropdownMenuItem(
                text = { Text("style $id") },
                onClick = {
                    open = false
                    onPick(id)
                },
            )
        }
    }
}

/**
 * Draws a generated line scaled to fit, revealing it in pen time. Each
 * engine gets its tuned ink look from ink-render: "ribbon" fills
 * speed-shaped outline polygons (ink pools where the pen is slow), "pen"
 * strokes width-bucketed runs from speed-based pen widths.
 */
@Composable
private fun InkCanvas(strokes: List<InkStroke>, engine: Engine, revealed: Int, dimmed: Boolean) {
    val color = MaterialTheme.colorScheme.onSurface.let {
        if (dimmed) it.copy(alpha = 0.4f) else it
    }
    Canvas(modifier = Modifier.fillMaxSize().padding(24.dp)) {
        val bounds = lineBounds(strokes) ?: return@Canvas
        val scale = minOf(
            size.width / maxOf(bounds.width, 1.0),
            size.height / maxOf(bounds.height, 1.0),
            4.0,
        )
        val placed = transformLine(
            strokes,
            scale = scale,
            translateX = (size.width - bounds.width * scale) / 2 - bounds.minX * scale,
            translateY = (size.height - bounds.height * scale) / 2 - bounds.minY * scale,
        )
        when (engine) {
            Engine.CALLIGRAPHER -> drawRibbons(placed, scale, revealed, color)
            Engine.LONGHAND -> drawPen(placed, scale, revealed, color)
        }
    }
}

/** The web app's calligrapher ribbon weight: 2x the reference width. */
private val ribbonInkWidth = ribbonWidthDefault * 2

/** The web app's pen weight per unit of layout scale. */
private const val PEN_WIDTH_PER_SCALE = 2.2 / 1.6

private fun DrawScope.drawRibbons(placed: List<InkStroke>, scale: Double, revealed: Int, color: Color) {
    var remaining = revealed
    for (stroke in placed) {
        if (remaining <= 0) break
        val first = stroke.points.firstOrNull() ?: break
        val visible = minOf(stroke.points.size, remaining)
        remaining -= visible
        val prefix = stroke.points.subList(0, visible)
        val outline = ribbonOutline(prefix, scale = scale, width = ribbonInkWidth)
        if (outline == null) {
            // Touchdown dot until the stroke grows a second point.
            drawCircle(color, radius = 1.2f, center = androidx.compose.ui.geometry.Offset(first.x.toFloat(), first.y.toFloat()))
            continue
        }
        val (start, segments) = ribbonSegments(outline)
        val path = Path()
        path.moveTo(start.x.toFloat(), start.y.toFloat())
        for (segment in segments) {
            path.cubicTo(
                segment.control1.x.toFloat(), segment.control1.y.toFloat(),
                segment.control2.x.toFloat(), segment.control2.y.toFloat(),
                segment.end.x.toFloat(), segment.end.y.toFloat(),
            )
        }
        path.close()
        drawPath(path, color)
    }
}

private fun DrawScope.drawPen(placed: List<InkStroke>, scale: Double, revealed: Int, color: Color) {
    val pen = PenWidthOptions(base = PEN_WIDTH_PER_SCALE * scale)
    for (stroke in penStrokes(placed, pen)) {
        val touchdown = stroke.touchdown
        if (touchdown.index >= revealed) break
        drawCircle(
            color,
            radius = touchdown.r.toFloat(),
            center = androidx.compose.ui.geometry.Offset(touchdown.x.toFloat(), touchdown.y.toFloat()),
        )
        for (run in stroke.runs) {
            val visible = minOf(run.points.size, revealed - run.startIndex)
            if (visible <= 1) continue
            val path = Path()
            path.moveTo(run.points[0].x.toFloat(), run.points[0].y.toFloat())
            for (point in run.points.subList(1, visible)) {
                path.lineTo(point.x.toFloat(), point.y.toFloat())
            }
            drawPath(
                path,
                color,
                style = Stroke(
                    width = run.width.toFloat(),
                    cap = StrokeCap.Round,
                    join = StrokeJoin.Round,
                ),
            )
        }
    }
}
