// @ts-nocheck

import deleteDrawersTool from "../../../tools/delete_drawers.ts"
import moveDrawersTool from "../../../tools/move_drawers.ts"
import captureTranscriptTool from "../../../tools/capture_transcript.ts"
import palaceReportTool from "../../../tools/palace_report.ts"
import palaceFlockStatusTool from "../../../tools/palace_flock_status.ts"
import palaceDiffTool from "../../../tools/palace_diff.ts"
import palaceListDrawersMultiRoomTool from "../../../tools/palace_list_drawers_multi_room.ts"
import palaceHeightThresholdTool from "../../../tools/palace_height_threshold.ts"
import palaceOrganizeMemoriesTool from "../../../tools/palace_organize_memories.ts"
import exportDrawerTool from "../../../tools/export_drawer.ts"
import relocateMemoryTool from "../../../tools/relocate_memory.ts"
import palaceStampSourceTypeTool from "../../../tools/palace_stamp_source_type.ts"
import ingestDocsTool from "../../../tools/ingest_docs.ts"
import proposeConcernsTool from "../../../tools/propose_concerns.ts"
import fileSkillTool from "../../../tools/file_skill.ts"
import proposeRefinementsTool from "../../../tools/propose_refinements.ts"
import recordOutcomeTool from "../../../tools/record_outcome.ts"
import promoteSkillTool from "../../../tools/promote_skill.ts"
import remindTool from "../../../tools/remind.ts"

export function createToolRegistry() {
  return {
    delete_drawers: deleteDrawersTool,
    move_drawers: moveDrawersTool,
    capture_transcript: captureTranscriptTool,
    palace_report: palaceReportTool,
    palace_flock_status: palaceFlockStatusTool,
    palace_diff: palaceDiffTool,
    palace_list_drawers_multi_room: palaceListDrawersMultiRoomTool,
    palace_height_threshold: palaceHeightThresholdTool,
    palace_organize_memories: palaceOrganizeMemoriesTool,
    export_drawer: exportDrawerTool,
    relocate_memory: relocateMemoryTool,
    palace_stamp_source_type: palaceStampSourceTypeTool,
    ingest_docs: ingestDocsTool,
    propose_concerns: proposeConcernsTool,
    file_skill: fileSkillTool,
    propose_refinements: proposeRefinementsTool,
    record_outcome: recordOutcomeTool,
    promote_skill: promoteSkillTool,
    remind: remindTool,
  }
}
