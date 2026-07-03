/** Messages between the UI and the engine worker. */

export type EngineId = "graves" | "calligrapher";

/** How a line should be painted: variable-width pen strokes (the graves
 * pipeline) or filled speed-shaped ribbons (the calligrapher pipeline). */
export type RendererKind = "pen" | "ribbon";

export interface EngineDescriptor {
  id: EngineId;
  label: string;
  renderer: RendererKind;
  styles: number[];
  alphabet: string[];
  /** What style=null means for this engine (freehand vs. random style). */
  nullStyleLabel: string;
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
