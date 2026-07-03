/**
 * Engine worker: loads the model once, then turns write requests into
 * streamed batches of stroke offsets. Everything heavy (the 15 MB weights
 * parse, style priming, sampling) happens here so the page never janks.
 */

import { GravesModel, parseModelAssets, STEPS_PER_CHARACTER } from "@longhand/ink-graves";
import type { WorkerEvent, WriteRequest } from "./protocol.js";

const post = (event: WorkerEvent): void => self.postMessage(event);

let model: GravesModel | null = null;
let jobId = 0;

const ready = (async () => {
  const response = await fetch("/model/graves-v1.bin");
  if (!response.ok) throw new Error(`model fetch failed (HTTP ${response.status})`);
  model = new GravesModel(parseModelAssets(await response.arrayBuffer()));
  post({
    type: "ready",
    styles: model.assets.styles.map((style) => style.id),
    alphabet: model.assets.alphabet,
  });
})().catch((error: unknown) => post({ type: "error", message: String(error) }));

self.onmessage = async (event: MessageEvent<WriteRequest>) => {
  const request = event.data;
  if (request.type !== "write") return;
  const current = ++jobId;
  await ready;
  if (!model || current !== jobId) return;

  try {
    if (request.style !== null) post({ type: "status", message: "warming up the style…" });
    // Style priming happens synchronously inside writer(); a few seconds
    // for long primers, which is why it lives in this worker.
    const writer = model.writer(request.text, {
      bias: request.bias,
      style: request.style,
      seed: request.seed,
    });
    post({ type: "start", jobId: current });

    const stepBudget = STEPS_PER_CHARACTER * Math.max(request.text.length, 4);
    let produced = 0;
    while (!writer.done && produced < stepBudget && current === jobId) {
      const batch: Array<[number, number, number]> = [];
      for (let i = 0; i < 16 && produced < stepBudget; i++) {
        const offset = writer.step();
        if (offset === null) break;
        batch.push([offset[0], offset[1], offset[2]]);
        produced++;
      }
      if (batch.length > 0) post({ type: "offsets", jobId: current, batch });
      // Yield so a newer write request can preempt between batches.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (current === jobId) post({ type: "done", jobId: current });
  } catch (error) {
    post({ type: "error", message: String(error) });
  }
};
