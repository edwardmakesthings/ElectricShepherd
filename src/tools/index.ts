/**
 * The tool set, harness-neutral.
 *
 * Both surfaces bind this same list: `src/surface/opencode/tool-adapter.ts` and
 * `src/surface/omp/tool-adapter.ts`. Each definition carries its own `name`, so
 * a registry keyed by name is derived rather than maintained by hand.
 */

import type { EsToolDefinition } from "./contract.ts";

import captureTranscript from "./capture_transcript.ts";
import deleteDrawers from "./delete_drawers.ts";
import exportDrawer from "./export_drawer.ts";
import fileSkill from "./file_skill.ts";
import ingestDocs from "./ingest_docs.ts";
import moveDrawers from "./move_drawers.ts";
import palaceDiff from "./palace_diff.ts";
import consolidationProgress from "./consolidation_progress.ts";
import palaceFlockStatus from "./palace_flock_status.ts";
import palaceHeightThreshold from "./palace_height_threshold.ts";
import palaceListDrawersMultiRoom from "./palace_list_drawers_multi_room.ts";
import palaceOrganizeMemories from "./palace_organize_memories.ts";
import palaceReport from "./palace_report.ts";
import palaceStampSourceType from "./palace_stamp_source_type.ts";
import promoteSkill from "./promote_skill.ts";
import proposeConcerns from "./propose_concerns.ts";
import proposeRefinements from "./propose_refinements.ts";
import recordOutcome from "./record_outcome.ts";
import relocateMemory from "./relocate_memory.ts";
import remind from "./remind.ts";

export const ES_TOOLS: readonly EsToolDefinition[] = [
  captureTranscript,
  consolidationProgress,
  deleteDrawers,
  exportDrawer,
  fileSkill,
  ingestDocs,
  moveDrawers,
  palaceDiff,
  palaceFlockStatus,
  palaceHeightThreshold,
  palaceListDrawersMultiRoom,
  palaceOrganizeMemories,
  palaceReport,
  palaceStampSourceType,
  promoteSkill,
  proposeConcerns,
  proposeRefinements,
  recordOutcome,
  relocateMemory,
  remind,
];
