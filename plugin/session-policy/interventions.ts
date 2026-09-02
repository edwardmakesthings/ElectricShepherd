// @ts-nocheck

// Domain category: mem-core reinjection intervention.
// Moved verbatim from pure-helpers.ts — see the compatibility re-export there.

import { dirname } from "node:path"
import { existsSync } from "node:fs"
import {
  writeStatusFile, appendMemcoreContextLog, resolveScopeDirFromEvent,
  extractPathFromMessageParts, loadMemcoreMarkdown,
} from "./pure-helpers.ts"
import { getPromptRouting } from "./routing.ts"
import { MEMCORE_REINJECT_MARKER } from "./constants.ts"
import {
  clipText,
  computeMemcoreSignature,
  decideMemcoreInjectionWithGating,
} from "../../adapter/turn-guard-helpers.ts"
import type {
  MemcoreInjectionRecord,
  MemcoreReinjectReason,
} from "../../adapter/turn-guard-helpers.ts"
import type { MessageWithParts } from "./constants.ts"

export async function maybeInjectMemcoreWithGating(args: {

  sid: string

  event: any

  reason: MemcoreReinjectReason

  messages?: MessageWithParts[]

  anchor?: MessageWithParts | null

  force?: boolean

  rootDirectory: string

  projectRoot: string

  directory: string

  client: any

  cfgRaw: (path: string) => string

  cfgNum: (path: string, fallback: number) => number

  cfgCSV: (path: string) => string[]

  memcoreInjectEnabled: boolean

  memcoreInjectOnIdle: boolean

  memcoreInjectOnCompacted: boolean

  memcoreInjectOnStart: boolean

  memcoreMaxChars: number

  injectionCooldownMs: number

  memcoreInjectionBySession: Map<string, MemcoreInjectionRecord>

  statusSnapshot: (extra?: Record<string, unknown>) => Record<string, unknown>

}): Promise<boolean> {

  const reinjectConfig = {

    enabled: args.memcoreInjectEnabled,

    onIdle: args.memcoreInjectOnIdle,

    onCompact: args.memcoreInjectOnCompacted,

    onStart: args.memcoreInjectOnStart,

  }



  if (!reinjectConfig.enabled) {

    appendMemcoreContextLog(args.projectRoot, {

      type: "memcore-reinject",

      sid: args.sid,

      reason: args.reason,

      injected: false,

      because: "reinject-disabled",

    })

    writeStatusFile(args.projectRoot, args.statusSnapshot({

      type: "memcore-reinject",

      sid: args.sid,

      reason: args.reason,

      injected: false,

      because: "reinject-disabled",

    }))

    return false

  }



  const perReasonFlag =

    args.reason === "idle" ? reinjectConfig.onIdle

    : args.reason === "compacted" || args.reason === "compacting" ? reinjectConfig.onCompact

    : reinjectConfig.onStart

  if (!perReasonFlag) {

    appendMemcoreContextLog(args.projectRoot, {

      type: "memcore-reinject",

      sid: args.sid,

      reason: args.reason,

      injected: false,

      because: `reinject-${args.reason}-disabled`,

    })

    writeStatusFile(args.projectRoot, args.statusSnapshot({

      type: "memcore-reinject",

      sid: args.sid,

      reason: args.reason,

      injected: false,

      because: `reinject-${args.reason}-disabled`,

    }))

    return false

  }



  let scopeDir = resolveScopeDirFromEvent(args.event, args.rootDirectory, args.cfgRaw("memcore.scopeDir"))

  const pathFromMessages = extractPathFromMessageParts(args.messages || [])

  if (pathFromMessages) {

    scopeDir = existsSync(pathFromMessages) && !pathFromMessages.endsWith(".md") && !pathFromMessages.endsWith(".ts")

      ? pathFromMessages

      : dirname(pathFromMessages)

  }



  const { markdown, loaderInfo } = await loadMemcoreMarkdown(args.projectRoot, scopeDir, {

    maxScopes: args.cfgNum("memcore.maxScopes", 6),

    directFileName: args.cfgRaw("memcore.directFileName") || "memory.md",

    storeRoots: args.cfgCSV("memcore.storeRoots").length > 0 ? args.cfgCSV("memcore.storeRoots") : [".electric-shepherd/memory"],

    timeoutMs: args.cfgNum("commands.memcoreLoader.timeoutMs", 30000),

  })

  if (!markdown) {

    appendMemcoreContextLog(args.projectRoot, {

      type: "memcore-reinject",

      sid: args.sid,

      reason: args.reason,

      scopeDir,

      injected: false,

      because: "no-memcore-markdown",

    })

    writeStatusFile(args.projectRoot, args.statusSnapshot({

      type: "memcore-reinject",

      sid: args.sid,

      reason: args.reason,

      scopeDir,

      injected: false,

      because: "no-memcore-markdown",

      loaderInfo,

    }))

    return false

  }



  const reinjectPrelude =

    `${MEMCORE_REINJECT_MARKER} Refreshing scoped mem-core for this session (reason=${args.reason}). ` +

    `Use this as the currently active resident memory for scope: ${scopeDir}. ` +

    "This is derived render output from derived memory; do not hand-edit mem-core files.\n\n"

  const clipped = clipText(markdown, Math.max(0, args.memcoreMaxChars - reinjectPrelude.length))

  const signature = computeMemcoreSignature(scopeDir, clipped)

  const now = Date.now()

  const previous = args.memcoreInjectionBySession.get(args.sid)

  const { inject, because } = decideMemcoreInjectionWithGating({

    reason: args.reason,

    config: reinjectConfig,

    scopeDir,

    signature,

    now,

    previous,

    cooldownMs: args.injectionCooldownMs,

    force: args.force,

  })



  if (!inject) {

    appendMemcoreContextLog(args.projectRoot, {

      type: "memcore-reinject",

      sid: args.sid,

      reason: args.reason,

      scopeDir,

      injected: false,

      signature,

      because,

    })

    writeStatusFile(args.projectRoot, args.statusSnapshot({

      type: "memcore-reinject",

      sid: args.sid,

      reason: args.reason,

      scopeDir,

      injected: false,

      signature,

      because,

      loaderInfo,

    }))

    return false

  }



  try {

    const routing = getPromptRouting(args.anchor)

    const body: any = {

      parts: [

        {

          type: "text",

          text: reinjectPrelude + clipped,

        },

      ],

    }

    if (routing.agent) body.agent = routing.agent

    if (routing.model) body.model = routing.model



    await args.client.session.prompt({

      path: { id: args.sid },

      query: { directory: args.directory },

      body,

    })



    args.memcoreInjectionBySession.set(args.sid, { signature, at: now, scopeDir })

    appendMemcoreContextLog(args.projectRoot, {

      type: "memcore-reinject",

      sid: args.sid,

      reason: args.reason,

      scopeDir,

      injected: true,

      signature,

      chars: clipped.length,

      preview: clipText(clipped, 1800),

    })

    writeStatusFile(args.projectRoot, args.statusSnapshot({

      type: "memcore-reinject",

      sid: args.sid,

      reason: args.reason,

      scopeDir,

      injected: true,

      signature,

      loaderInfo,

    }))

    console.log(`[turn-guard] mem-core re-injected sid=${args.sid} reason=${args.reason} scope=${scopeDir}`)

    return true

  } catch (err) {

    appendMemcoreContextLog(args.projectRoot, {

      type: "memcore-reinject",

      sid: args.sid,

      reason: args.reason,

      scopeDir,

      injected: false,

      signature,

      because: "injection-error",

      error: String(err),

    })

    writeStatusFile(args.projectRoot, args.statusSnapshot({

      type: "memcore-reinject",

      sid: args.sid,

      reason: args.reason,

      scopeDir,

      injected: false,

      signature,

      because: "injection-error",

      error: String(err),

      loaderInfo,

    }))

    console.error(`[turn-guard] failed mem-core re-injection sid=${args.sid}:`, err)

    return false

  }

}
