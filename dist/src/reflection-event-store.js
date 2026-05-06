import { createHash } from "node:crypto";
export const REFLECTION_SCHEMA_VERSION = 4;
export function createReflectionEventId(params) {
    const safeRunAt = Number.isFinite(params.runAt) ? Math.max(0, Math.floor(params.runAt)) : Date.now();
    const datePart = new Date(safeRunAt).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const digest = createHash("sha1")
        .update(`${safeRunAt}|${params.sessionKey}|${params.sessionId}|${params.agentId}|${params.command}`)
        .digest("hex")
        .slice(0, 8);
    return `refl-${datePart}-${digest}`;
}
export function buildReflectionEventPayload(params) {
    const eventId = params.eventId || createReflectionEventId({
        runAt: params.runAt,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        agentId: params.agentId,
        command: params.command,
    });
    const metadata = {
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
