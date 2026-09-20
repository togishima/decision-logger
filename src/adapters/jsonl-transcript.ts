import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkMessage, WorkToolCall, ChangedResource } from "../core/model/session.ts";

/**
 * Tolerant JSONL transcript reading, shared by the agent adapters.
 *
 * All three supported environments write JSONL and all three say, in their own
 * documentation, that the line schema is internal and may change between
 * releases. So this parser recognises shapes rather than versions: it looks for
 * a role and some text wherever they happen to be, and silently skips anything
 * it does not understand. A transcript it cannot read yields zero decisions,
 * never an exception.
 */

export interface ParsedTranscript {
  messages: WorkMessage[];
  toolCalls: WorkToolCall[];
  changedResources: ChangedResource[];
  /** Line index read up to, for incremental ingestion. */
  cursor: number;
  firstAt?: string;
  lastAt?: string;
  cwd?: string;
  sessionId?: string;
  /** Lines that parsed as JSON but matched no known shape. */
  unrecognized: number;
}

const EDIT_TOOLS = /^(write|edit|multiedit|apply_patch|notebookedit|str_replace|create_file)$/i;

export function readJsonlTranscript(path: string, fromCursor = 0): ParsedTranscript {
  if (!existsSync(path)) return emptyTranscript(fromCursor);
  try {
    return parseJsonlTranscript(readFileSync(path, "utf8"), fromCursor);
  } catch {
    return emptyTranscript(fromCursor);
  }
}

function emptyTranscript(cursor: number): ParsedTranscript {
  return { messages: [], toolCalls: [], changedResources: [], cursor, unrecognized: 0 };
}

/** Same parsing as `readJsonlTranscript`, for input that never touched disk. */
export function parseJsonlTranscript(raw: string, fromCursor = 0): ParsedTranscript {
  const out = emptyTranscript(fromCursor);
  const lines = raw.split("\n");
  for (let i = fromCursor; i < lines.length; i++) {
    const line = lines[i]!.trim();
    out.cursor = i + 1;
    if (!line) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a partially written last line is normal while a session is live
    }
    if (typeof entry !== "object" || entry === null) continue;

    if (!absorb(entry as Record<string, unknown>, out)) out.unrecognized += 1;
  }

  return out;
}

/** Returns false when the line matched no known shape. */
function absorb(entry: Record<string, unknown>, out: ParsedTranscript): boolean {
  const at = firstString(entry.timestamp, entry.created_at, entry.time, entry.at);
  if (at) {
    out.firstAt ??= at;
    out.lastAt = at;
  }
  out.cwd ??= firstString(entry.cwd, entry.workingDirectory);
  out.sessionId ??= firstString(entry.sessionId, entry.session_id, entry.conversation_id);

  // Sidechain / subagent traffic belongs to a different unit of work.
  if (entry.isSidechain === true) return true;

  // Shape A: Claude Code and Cursor — { type, message: { role, content } }
  const message = asRecord(entry.message);
  if (message && typeof message.role === "string") {
    consumeMessage(message, at, out);
    return true;
  }

  // Shape B: Codex rollout — { type, payload: { type?, role?, content? } }.
  // The kind may live on the entry (session_meta) or on the payload
  // (event_msg → user_message), so both are consulted.
  const payload = asRecord(entry.payload);
  if (payload) {
    const entryType = typeof entry.type === "string" ? entry.type : "";
    return consumeCodexPayload(payload, entryType, at, out);
  }

  // Shape C: flat — { role, content }
  if (typeof entry.role === "string") {
    consumeMessage(entry, at, out);
    return true;
  }

  return false;
}

function consumeMessage(message: Record<string, unknown>, at: string | undefined, out: ParsedTranscript): void {
  const role = normalizeRole(String(message.role));
  if (!role) return;

  const { text, reasoning, tools } = flattenContent(message.content);
  for (const tool of tools) {
    out.toolCalls.push({ name: tool.name, summary: tool.summary, at });
    recordChange(tool, out);
  }

  if (text.trim() || reasoning.trim()) {
    out.messages.push({
      role,
      text: text.trim(),
      reasoning: reasoning.trim() || undefined,
      at,
    });
  }
}

function consumeCodexPayload(
  payload: Record<string, unknown>,
  entryType: string,
  at: string | undefined,
  out: ParsedTranscript,
): boolean {
  const type = typeof payload.type === "string" && payload.type ? payload.type : entryType;

  if (type === "message" || type === "user_message" || type === "agent_message") {
    const role = normalizeRole(
      typeof payload.role === "string"
        ? payload.role
        : type === "user_message"
          ? "user"
          : "assistant",
    );
    if (!role) return true;
    const { text, reasoning } = flattenContent(payload.content ?? payload.message ?? payload.text);
    if (text.trim() || reasoning.trim()) {
      out.messages.push({ role, text: text.trim(), reasoning: reasoning.trim() || undefined, at });
    }
    return true;
  }

  if (type === "reasoning" || type === "agent_reasoning") {
    const { text } = flattenContent(payload.content ?? payload.summary ?? payload.text);
    const last = out.messages.at(-1);
    if (last?.role === "assistant" && text.trim()) {
      last.reasoning = `${last.reasoning ?? ""}\n${text.trim()}`.trim();
    }
    return true;
  }

  if (type === "function_call" || type === "custom_tool_call") {
    const name = firstString(payload.name, payload.tool_name) ?? "tool";
    const tool: ToolInvocation = {
      name,
      summary: summarizeInput(payload.arguments ?? payload.input),
      input: asRecord(payload.arguments ?? payload.input),
    };
    out.toolCalls.push({ name: tool.name, summary: tool.summary, at });
    recordChange(tool, out);
    return true;
  }

  if (type === "session_meta") {
    out.cwd ??= firstString(payload.cwd);
    out.sessionId ??= firstString(payload.session_id, payload.id);
    return true;
  }

  // Known-but-uninteresting rollout entries: counted as understood, not noise.
  return ["token_count", "task_started", "task_complete", "item_completed", "turn_context"].includes(
    type,
  );
}

interface ToolInvocation {
  name: string;
  summary?: string;
  input?: Record<string, unknown>;
}

interface FlattenedContent {
  text: string;
  reasoning: string;
  tools: ToolInvocation[];
}

/** Flattens the several content-block shapes these tools use into plain text. */
function flattenContent(content: unknown): FlattenedContent {
  const out: FlattenedContent = { text: "", reasoning: "", tools: [] };

  if (typeof content === "string") {
    out.text = content;
    return out;
  }
  if (!Array.isArray(content)) {
    const record = asRecord(content);
    if (record && typeof record.text === "string") out.text = record.text;
    return out;
  }

  const textParts: string[] = [];
  const reasoningParts: string[] = [];

  for (const block of content) {
    if (typeof block === "string") {
      textParts.push(block);
      continue;
    }
    const record = asRecord(block);
    if (!record) continue;
    const type = typeof record.type === "string" ? record.type : "";

    switch (type) {
      case "text":
      case "input_text":
      case "output_text":
        if (typeof record.text === "string") textParts.push(record.text);
        break;
      case "thinking":
      case "reasoning":
        if (typeof record.thinking === "string") reasoningParts.push(record.thinking);
        else if (typeof record.text === "string") reasoningParts.push(record.text);
        break;
      case "tool_use":
      case "function_call": {
        const name = firstString(record.name, record.tool_name) ?? "tool";
        out.tools.push({
          name,
          summary: summarizeInput(record.input ?? record.arguments),
          input: asRecord(record.input ?? record.arguments),
        });
        break;
      }
      case "tool_result":
      case "function_call_output":
        // Results are large and rarely carry rationale; the call itself is enough.
        break;
      default:
        if (typeof record.text === "string") textParts.push(record.text);
    }
  }

  out.text = textParts.join("\n");
  out.reasoning = reasoningParts.join("\n");
  return out;
}

function recordChange(tool: ToolInvocation, out: ParsedTranscript): void {
  if (!EDIT_TOOLS.test(tool.name)) return;
  const ref = firstString(
    tool.input?.file_path,
    tool.input?.path,
    tool.input?.filePath,
    tool.input?.target_file,
  );
  if (!ref) return;
  if (out.changedResources.some((r) => r.ref === ref)) return;
  out.changedResources.push({ kind: "file", ref, changeType: "modified" });
}

/** One short line describing a tool call — never the full payload. */
function summarizeInput(input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) return typeof input === "string" ? truncate(input, 120) : undefined;
  const interesting = firstString(
    record.file_path,
    record.path,
    record.command,
    record.pattern,
    record.query,
    record.description,
  );
  return interesting ? truncate(interesting, 120) : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function normalizeRole(role: string): WorkMessage["role"] | undefined {
  const lowered = role.toLowerCase();
  if (lowered === "user" || lowered === "human") return "user";
  if (lowered === "assistant" || lowered === "model" || lowered === "agent") return "assistant";
  if (lowered === "system" || lowered === "developer") return "system";
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Filesystem scanning                                                 */
/* ------------------------------------------------------------------ */

export interface FoundFile {
  path: string;
  modifiedAt: string;
}

/** Recursively lists files matching `test`, newest first. */
export function findFiles(
  root: string,
  test: (name: string) => boolean,
  options: { maxDepth?: number; limit?: number } = {},
): FoundFile[] {
  const found: FoundFile[] = [];
  const maxDepth = options.maxDepth ?? 4;

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full, depth + 1);
      else if (test(entry)) found.push({ path: full, modifiedAt: stat.mtime.toISOString() });
    }
  };

  if (existsSync(root)) walk(root, 0);
  found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return options.limit ? found.slice(0, options.limit) : found;
}
