import assert from "node:assert/strict";
import test from "node:test";

import { matchesAgentIdentity } from "../../src/policy/agent-identity.ts";

// Matching the identity sentence, not a keyword, so a transcript that merely
// discusses an agent by name cannot trip a gate built on this signal.
test("matchesAgentIdentity recognises the identity sentence", () => {
  assert.equal(matchesAgentIdentity(["You are the Dreamer."], ["dreamer"]), true);
  assert.equal(matchesAgentIdentity(["You are dream-auditor."], ["dream-auditor"]), true);
});

test("matchesAgentIdentity rejects mentions that are not identity claims", () => {
  assert.equal(matchesAgentIdentity(["The dreamer consolidates memory."], ["dreamer"]), false);
  assert.equal(matchesAgentIdentity(["We discussed the Dreamer agent earlier."], ["dreamer"]), false);
  assert.equal(matchesAgentIdentity(["You are dream-auditor."], ["dreamer"]), false);
});

test("matchesAgentIdentity handles empty inputs", () => {
  assert.equal(matchesAgentIdentity([], ["dreamer"]), false);
  assert.equal(matchesAgentIdentity(["You are the Dreamer."], []), false);
});
