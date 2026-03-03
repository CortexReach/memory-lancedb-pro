export type GraphitiTransportMode = "auto" | "mcp";
export type GraphitiGroupIdMode = "scope" | "fixed";

export interface GraphitiWriteConfig {
  memoryStore: boolean;
  autoCapture: boolean;
  sessionSummary: boolean;
}

export interface GraphitiReadConfig {
  enableGraphRecallTool: boolean;
  augmentMemoryRecall: boolean;
  topKNodes: number;
  topKFacts: number;
}

export interface GraphitiPluginConfig {
  enabled: boolean;
  baseUrl: string;
  transport: GraphitiTransportMode;
  groupIdMode: GraphitiGroupIdMode;
  fixedGroupId?: string;
  timeoutMs: number;
  failOpen: boolean;
  write: GraphitiWriteConfig;
  read: GraphitiReadConfig;
}

export interface GraphitiEpisodeInput {
  text: string;
  scope: string;
  metadata?: Record<string, unknown>;
}

export interface GraphitiEpisodeResult {
  status: "stored" | "failed" | "skipped";
  groupId: string;
  episodeRef?: string;
  error?: string;
}

export interface GraphitiNodeResult {
  id?: string;
  label: string;
  score?: number;
  raw?: unknown;
}

export interface GraphitiFactResult {
  id?: string;
  text: string;
  score?: number;
  raw?: unknown;
}

export interface GraphitiRecallInput {
  query: string;
  scope: string;
  limitNodes: number;
  limitFacts: number;
}

export interface GraphitiRecallResult {
  groupId: string;
  nodes: GraphitiNodeResult[];
  facts: GraphitiFactResult[];
}
