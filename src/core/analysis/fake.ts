import type { Analyzer, AnalyzeRequest, AnalyzeResult, AnalyzePurpose } from "./analyzer.ts";

/**
 * Scripted analyzer used by the test suite.
 *
 * Every core behaviour — gating, validation, deduplication, supersession,
 * ranking, review history — is testable without a model because the model is
 * the only non-deterministic part of the system and it sits behind this port.
 */
export class FakeAnalyzer implements Analyzer {
  readonly name = "fake";
  readonly calls: AnalyzeRequest[] = [];
  private readonly queue: Map<AnalyzePurpose, AnalyzeResult[]> = new Map();

  /** Queues one response per purpose, consumed in order. */
  enqueue(purpose: AnalyzePurpose, data: unknown): this {
    const list = this.queue.get(purpose) ?? [];
    list.push({ ok: true, data });
    this.queue.set(purpose, list);
    return this;
  }

  enqueueFailure(purpose: AnalyzePurpose, error: string): this {
    const list = this.queue.get(purpose) ?? [];
    list.push({ ok: false, error });
    this.queue.set(purpose, list);
    return this;
  }

  async available(): Promise<boolean> {
    return true;
  }

  async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    this.calls.push(request);
    const next = this.queue.get(request.purpose)?.shift();
    if (next) return next;
    return {
      ok: true,
      data: request.purpose === "extract-decisions" ? { decisions: [] } : { proposals: [] },
    };
  }

  callCount(purpose: AnalyzePurpose): number {
    return this.calls.filter((c) => c.purpose === purpose).length;
  }

  lastPrompt(purpose: AnalyzePurpose): string | undefined {
    const matching = this.calls.filter((c) => c.purpose === purpose);
    return matching.at(-1)?.prompt;
  }
}
