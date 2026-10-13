import { RUN_IN_TERMINAL_TOOL_NAME } from '../constants';
import { TerminalIntentRecord, TerminalIntentToolCallLike } from './types';

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function extractTerminalIntent(
  part: TerminalIntentToolCallLike,
  timestamp: number = Date.now(),
): TerminalIntentRecord | undefined {
  const toolName = typeof part.name === 'string' ? part.name.trim() : '';
  if (toolName !== RUN_IN_TERMINAL_TOOL_NAME) {
    return undefined;
  }

  const callId = typeof part.callId === 'string' ? part.callId.trim() : '';
  if (!callId) {
    return undefined;
  }

  const input = part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>) : {};
  const goal = readTrimmedString(input.goal);
  const explanation = readTrimmedString(input.explanation);
  if (!goal && !explanation) {
    return undefined;
  }

  const command = readTrimmedString(input.command) || undefined;
  return {
    callId,
    toolName,
    goal,
    explanation,
    command,
    timestamp,
  };
}
