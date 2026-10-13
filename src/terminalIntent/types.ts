export interface TerminalIntentRecord {
  callId: string;
  toolName: string;
  goal: string;
  explanation: string;
  command?: string;
  timestamp: number;
}

export interface TerminalIntentToolCallLike {
  callId: string;
  name: string;
  input: unknown;
}
