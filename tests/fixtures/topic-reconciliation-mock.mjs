// Deterministic model seam only; production coordinator/parser/checkpoints run unchanged.
// Responds with a DELTA (topic-reconciliation-v4): add strings + remove indices against input.previous.
const SECTIONS = ["durableFacts", "decisions", "rootCausesAndWorkedExamples", "subsystemsAndFiles", "deadEnds"];
const empty = () => Object.fromEntries(SECTIONS.map((key) => [key, []]));
/** Build the full state the delta must yield, for tests that need to tamper with it. */
export function deltaResponse(input, { add = empty(), remove = empty(), openTaskIds, disposition = "incorporated", affectedEvidenceIds = [], confidence } = {}) {
  const value = { schemaVersion: 1, parentDrawerId: input.parentDrawerId, topicKey: input.topicKey, stepVersion: input.stepVersion,
    complete: true, openTaskIds: openTaskIds ?? input.eligibleOpenTasks.map((task) => task.taskId), add: { ...empty(), ...add }, remove: { ...empty(), ...remove },
    receipt: { evidenceId: input.evidence.evidenceId, disposition, affectedEvidenceIds,
      reason: "All structured evidence assessed against the current subject; source clarification supersedes only its matching claim." } };
  if (confidence) value.confidence = confidence;
  return JSON.stringify(value);
}
export function reconciliationResponse(input) {
  const record = input.evidence;
  const add = empty();
  const remove = empty();
  let disposition = "incorporated";
  let affectedEvidenceIds = [];
  let openTaskIds = input.eligibleOpenTasks.map((task) => task.taskId);
  if (record.topic) {
    // Seed: previous is null, the delta adds the whole first record. Later: add only unseen strings.
    for (const section of SECTIONS) add[section] = record.topic[section].filter((item) => !(input.previous?.[section] || []).includes(item));
  }
  if (record.context) {
    if (input.topicKey !== "architecture") disposition = "unrelated";
    else {
      disposition = record.context.kind === "correction" ? "corrected" : record.context.kind === "resolution" ? "resolved" : "qualified";
      affectedEvidenceIds = input.priorEvidenceIds.slice(0, 1);
      openTaskIds = [];
      add.durableFacts = [record.context.text];
    }
  }
  return deltaResponse(input, { add, remove, openTaskIds, disposition, affectedEvidenceIds });
}
