import { createHash } from "node:crypto";

export const REFLECTION_SCHEMA_VERSION = 4;

export type ReflectionErrorSignalLike = {
  signatureHash: string;
};

export interface ReflectionEventMetadata {
  type: "memory-reflection-event";
  reflectionVersion: 4;
  stage: "reflect-store";
  eventId: string;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  command: string;
  storedAt: number;
  usedFallback: boolean;
  errorSignals: string[];
  sourceReflectionPath?: string;
}

export interface ReflectionEventPayload {
  kind: "event";
  text: string;
  metadata: ReflectionEventMetadata;
}

export interface BuildReflectionEventPayloadParams {
  eventId?: string;
  scope: string;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  command: string;
  toolErrorSignals: ReflectionErrorSignalLike[];
  runAt: number;
  usedFallback: boolean;
  sourceReflectionPath?: string;
}

export function createReflectionEventId(params: {
  runAt: number;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  command: string;
}): string {
  const safeRunAt = Number.isFinite(params.runAt) ? Math.max(0, Math.floor(params.runAt)) : Date.now();
  const datePart = new Date(safeRunAt).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const digest = createHash("sha1")
    .update(`${safeRunAt}|${params.sessionKey}|${params.sessionId}|${params.agentId}|${params.command}`)
    .digest("hex")
    .slice(0, 8);
  return `refl-${datePart}-${digest}`;
}

export function buildReflectionEventPayload(params: BuildReflectionEventPayloadParams): ReflectionEventPayload {
  const eventId = params.eventId || createReflectionEventId({
    runAt: params.runAt,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    command: params.command,
  });

  const metadata: ReflectionEventMetadata = {
    type: "memory-reflection-event",
    reflectionVersion: REFLECTION_SCHEMA_VERSION,
    stage: "reflect-store",
    eventId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    command: params.command,
    storedAt: params.runAt,
    usedFallback: params.usedFallback,
    errorSignals: params.toolErrorSignals.map((signal) => signal.signatureHash),
    ...(params.sourceReflectionPath ? { sourceReflectionPath: params.sourceReflectionPath } : {}),
  };

  const text = [
    `reflection-event · ${params.scope}`,
    `eventId=${eventId}`,
    `session=${params.sessionId}`,
    `agent=${params.agentId}`,
    `command=${params.command}`,
    `usedFallback=${params.usedFallback ? "true" : "false"}`,
  ].join("\n");

  return {
    kind: "event",
    text,
    metadata,
  };
}
