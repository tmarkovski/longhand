/** Messages between the UI and the engine worker. */

export interface WriteRequest {
  type: "write";
  text: string;
  bias: number;
  style: number | null;
  seed: number;
}

export type WorkerEvent =
  | { type: "ready"; styles: number[]; alphabet: string[] }
  | { type: "status"; message: string }
  | { type: "start"; jobId: number }
  | { type: "offsets"; jobId: number; batch: Array<[number, number, number]> }
  | { type: "done"; jobId: number }
  | { type: "error"; message: string };
