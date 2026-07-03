/** Messages between the UI and the engine worker. */

export type EngineId = "graves" | "calligrapher";

/** How a line should be painted: variable-width pen strokes (the graves
 * pipeline) or filled speed-shaped ribbons (the calligrapher pipeline). */
export type RendererKind = "pen" | "ribbon";

export interface EngineDescriptor {
  id: EngineId;
  label: string;
  /** The engine's native ink look, used as the default stroke type. */
  renderer: RendererKind;
  /** Corrects ribbon width for the engine's model units: the ribbon's
   * speed term is unit-sensitive, and graves units run ~3x larger than
   * the calligrapher units the reference width was tuned for. */
  ribbonWidthFactor: number;
  styles: number[];
  alphabet: string[];
  /** What style=null means for this engine (e.g. freehand), or null when
   * the engine has no such mode and always writes with a style. */
  nullStyleLabel: string | null;
  /** Style selected when the engine activates. */
  defaultStyle: number | null;
  maxTextLength: number;
}

export interface WriteRequest {
  type: "write";
  engine: EngineId;
  text: string;
  bias: number;
  style: number | null;
  seed: number;
}

export interface SelectEngineRequest {
  type: "engine";
  engine: EngineId;
}

export type WorkerRequest = WriteRequest | SelectEngineRequest;

export type WorkerEvent =
  | { type: "ready"; engine: EngineDescriptor }
  | { type: "status"; message: string }
  | { type: "start"; jobId: number }
  | { type: "offsets"; jobId: number; batch: Array<[number, number, number]> }
  | { type: "done"; jobId: number }
  | { type: "error"; message: string };
