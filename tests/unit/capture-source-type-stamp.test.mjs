import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "..", "..", "src", "scripts", "capture-source-transcripts.sh");

/**
 * Phase 1 (unified memory): the source-capture pipeline must stamp every newly
 * created drawer with `es-source-type = transcript` via kg_add, best-effort.
 *
 * This test extracts the Python heredoc embedded in capture-source-transcripts.sh,
 * pulls out its real `add_with_chunking` / `stamp_source_type` function definitions
 * (via AST, so we exercise the actual shipped code), and drives them through a fake
 * MCP transport — no network. It proves:
 *   1. single-drawer path stamps exactly one kg_add es-source-type=transcript;
 *   2. chunked path stamps root + every child;
 *   3. a failing kg_add never fails the capture (best-effort contract).
 */

function extractHeredoc() {
  const source = readFileSync(scriptPath, "utf8");
  const lines = source.split("\n");
  const startIdx = lines.findIndex((line) => line.includes("<<'PY'"));
  assert.ok(startIdx >= 0, "capture script must contain a <<'PY' heredoc");
  let endIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "PY") {
      endIdx = i;
      break;
    }
  }
  assert.ok(endIdx > startIdx, "heredoc terminator 'PY' not found");
  return lines.slice(startIdx + 1, endIdx).join("\n");
}

// The driver runs the REAL functions from the capture script against a fake
// MCP transport. It is written as a Python program that receives the heredoc
// source on stdin and a JSON scenario on argv[1].
// The driver is written to a temp file and run with the heredoc + scenario JSON
// as its stdin (content can be arbitrarily large; argv would hit E2BIG).
const DRIVER = `
import ast
import json
import sys

stdin_text = sys.stdin.read()
heredoc, scenario_json = stdin_text.split("\\x00", 1)
scenario = json.loads(scenario_json)

# ── Pull the real function definitions out of the capture script's heredoc. ──
tree = ast.parse(heredoc)
wanted = {
    "decode_tool_json",
    "extract_drawer_id",
    "require_tool_success",
    "chunk_text",
    "add_with_chunking",
    "iter_drawers_by_source_file",
    "stamp_source_type",
}
func_defs = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
missing = wanted - {n.name for n in func_defs}
assert not missing, f"capture script heredoc is missing functions: {sorted(missing)}"

# The module-level names the functions close over.
tool_prefix = "mempalace_"
ingest_mode = "append"
wing = "test-wing"
room = "source-transcripts"
tool_add = tool_prefix + "add_drawer"
tool_update = tool_prefix + "update_drawer"
tool_kg = tool_prefix + "kg_add"

# ── Fake MCP transport. ──
calls = []
counter = {"n": 0}


def mcp_post(body):
    if body.get("method") != "tools/call":
        return {}
    name = body["params"]["name"]
    args = body["params"]["arguments"]
    calls.append({"name": name, "args": args})
    if name.endswith("kg_add"):
        if scenario.get("fail_kg_add") and args.get("predicate") == "es-source-type":
            raise RuntimeError("simulated kg_add failure")
        return {"result": {"content": [{"type": "text", "text": json.dumps({})}]}}
    if name.endswith("add_drawer"):
        counter["n"] += 1
        drawer_id = "drawer-" + str(counter["n"])
        content = str(args.get("content") or "")
        # The real server rejects oversized single-drawer adds; mirror that so the
        # chunked path is exercised. Only fire when the scenario wants it OR the
        # content genuinely exceeds the 95k chunk limit.
        if len(content) > 95_000:
            return {"result": {"content": [{"type": "text", "text": json.dumps({"success": False, "error": "content exceeds maximum length"})}]}}
        return {"result": {"content": [{"type": "text", "text": json.dumps({"success": True, "drawer_id": drawer_id})}]}}
    if name.endswith("update_drawer"):
        return {"result": {"content": [{"type": "text", "text": json.dumps({"success": True})}]}}
    if name.endswith("list_drawers"):
        return {"result": {"content": [{"type": "text", "text": json.dumps({"drawers": []})}]}}
    return {"result": {"content": [{"type": "text", "text": json.dumps({})}]}}


def tool_call(req_id, name, args):
    return mcp_post({
        "jsonrpc": "2.0",
        "id": req_id,
        "method": "tools/call",
        "params": {"name": name, "arguments": args},
    })


# ── Build a namespace with the real functions + their free variables. ──
ns = {
    "json": json,
    "tool_add": tool_add,
    "tool_update": tool_update,
    "tool_kg": tool_kg,
    "tool_prefix": tool_prefix,
    "ingest_mode": ingest_mode,
    "wing": wing,
    "room": room,
    "tool_call": tool_call,
}
module_src = ast.Module(body=func_defs, type_ignores=[])
exec(compile(module_src, "capture-heredoc-funcs", "exec"), ns)

# stamp_source_type uses a module-level counter via the global statement; exec
# in this dict makes that work. add_with_chunking calls the same ns tool_call etc.

content = scenario.get("content", "a short transcript")
result = ns["add_with_chunking"](
    {
        "wing": wing,
        "room": room,
        "content": content,
        "source_file": "opencode://session/s1/message.stop/t0",
        "added_by": "test",
    },
    "opencode://session/s1/message.stop/t0",
)

print(json.dumps({"result": result, "calls": calls}))
`;

const driverDir = mkdtempSync(join(tmpdir(), "capture-stamp-driver-"));

function runDriver(scenario) {
  const heredoc = extractHeredoc();
  const driverPath = join(driverDir, "driver.py");
  writeFileSync(driverPath, DRIVER);
  // NUL separates the (large) heredoc from the scenario JSON on stdin.
  return execFileSync("python3", [driverPath], {
    input: `${heredoc}\x00${JSON.stringify(scenario)}`,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

test.after(() => {
  rmSync(driverDir, { recursive: true, force: true });
});

function parseOutput(raw) {
  const lines = raw.trim().split("\n");
  const jsonLine = lines.find((line) => line.startsWith("{"));
  assert.ok(jsonLine, "expected a JSON result line from the driver");
  return JSON.parse(jsonLine);
}

test("capture: single-drawer path stamps es-source-type=transcript once", () => {
  const out = parseOutput(runDriver({ content: "a short transcript" }));

  assert.equal(out.result.status, "stored");
  const drawerId = out.result.drawer_id;
  assert.ok(drawerId, "single-drawer path must return a drawer id");

  const kgAdds = out.calls.filter((call) => call.name.endsWith("kg_add"));
  assert.equal(kgAdds.length, 1);
  assert.deepEqual(kgAdds[0].args, {
    subject: drawerId,
    predicate: "es-source-type",
    object: "transcript",
  });
});

test("capture: chunked path stamps root and every child", () => {
  // ~200k chars of content forces the maximum-length error → chunking at 95k.
  const bigContent = "x".repeat(200_000);
  const out = parseOutput(runDriver({ content: bigContent }));

  assert.equal(out.result.status, "stored-chunked");
  assert.ok(out.result.chunk_count >= 3, `expected >= 3 chunks, got ${out.result.chunk_count}`);

  const rootId = out.result.drawer_id;
  const kgAdds = out.calls.filter((call) => call.name.endsWith("kg_add"));
  const stampedSubjects = kgAdds.map((call) => call.args.subject).sort();

  // Every stamp is es-source-type=transcript.
  for (const call of kgAdds) {
    assert.equal(call.args.predicate, "es-source-type");
    assert.equal(call.args.object, "transcript");
  }
  // Root is stamped.
  assert.ok(stampedSubjects.includes(rootId), "root drawer must be stamped");
  // Every child is stamped: total stamps = root + (chunk_count - 1) children.
  assert.equal(kgAdds.length, out.result.chunk_count);
});

test("capture: a failing kg_add stamp never fails the capture", () => {
  const out = parseOutput(runDriver({ content: "a short transcript", fail_kg_add: true }));

  // Capture still succeeded even though the stamp call threw.
  assert.equal(out.result.status, "stored");
  assert.ok(out.result.drawer_id, "drawer must still be reported");
});
