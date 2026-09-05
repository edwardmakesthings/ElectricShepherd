// @ts-nocheck

// Domain category: shared session-state pruning helper.
// Extracted from handlers.ts verbatim.

/** Shared P3-1 pruning: bound all session-keyed state to prevent memory leaks. */
export function pruneAllSessionState(args: {
  retriedParentBySession: Map<string, Map<string, number>>
  retriesTotalBySession: Map<string, number>
  retryChainBySession: Map<string, number>
  retriesTotalBySession: Map<string, number>
  startupConfirmedBySession: Set<string>
  inspectedStopBySession: Map<string, Set<string>>
  toolWindowBySession: Map<string, Array<{ signature: string; atMessage: number }>>
  messageCountBySession: Map<string, number>
  lastCountedMessageIdBySession: Map<string, string>
  loopInterventionsBySession: Map<string, number>
  taskWindowBySession: Map<string, string[]>
  taskEscalationsBySession: Map<string, number>
  taskRecentLaunchBySession: Map<string, Map<string, number>>
  workedExampleFiledByShape: Map<string, Map<string, number>>
  capabilityRecordedBySession: Map<string, Set<string>>
  failureRecordedBySession: Map<string, Set<string>>
  pendingCalibrationBySession: Map<string, Array<{ modelId: string; shapeKey: string; confidence: string }>>
  pendingInterventionBySession: Map<string, Array<{ key: string; label: string; text: string }>>
  spiralNudgedBySession: Map<string, number>
  spiralInspectedBySession: Map<string, Set<string>>
  checkpointedSessions: Set<string>
  terminalCountBySession: Map<string, number>
  memcoreInjectionBySession: Map<string, { signature: string; at: number; scopeDir: string }>
  activeRoutingBySession: Map<string, { agent?: string; model?: { providerID: string; modelID: string } }>
  sourceCaptureBySession: Map<string, { totalEvents: number; lastEvent: string; lastAt: string; lastSuccess: boolean }>
  compactionPathBySession: Map<string, { path: "post-compact-fallback"; at: string }>
  autoConsolidationMaxTrackedSessions: number
  pruneToMax: (collection: Map<string, any> | Set<string>, max: number) => void
}): void {
  const { pruneToMax, autoConsolidationMaxTrackedSessions } = args
  pruneToMax(args.retriedParentBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.retriesTotalBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.retryChainBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.startupConfirmedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.inspectedStopBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.toolWindowBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.messageCountBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.lastCountedMessageIdBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.loopInterventionsBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.taskWindowBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.taskEscalationsBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.taskRecentLaunchBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.workedExampleFiledByShape, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.capabilityRecordedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.failureRecordedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.pendingCalibrationBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.pendingInterventionBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.spiralNudgedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.spiralInspectedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.checkpointedSessions, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.terminalCountBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.memcoreInjectionBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.activeRoutingBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.sourceCaptureBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.compactionPathBySession, autoConsolidationMaxTrackedSessions)
}
