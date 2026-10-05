import test from "node:test";
import assert from "node:assert/strict";
import { inspectProtocol, createCompatibilityChecker, assertFeatureSupported } from "../bridge/compatibility.mjs";
import { codexRpcError } from "../bridge/errors.mjs";

// Public app-server schema shape, including nullable refs and nested enum unions.
function protocol() {
  const params = {
    initialize: { clientInfo: {}, capabilities: { anyOf: [{ $ref: "#/definitions/Capabilities" }, { type: "null" }] } },
    "account/read": { refreshToken: {} }, "config/read": { cwd: {}, includeLayers: {} },
    "model/list": { limit: {}, cursor: {}, includeHidden: {} },
    "thread/start": { cwd: {}, sandbox: { enum: ["read-only"] }, approvalPolicy: { anyOf: [{ $ref: "#/definitions/Approval" }, { type: "null" }] },
      developerInstructions: {}, model: {}, modelProvider: {}, config: {}, ephemeral: {}, dynamicTools: {} },
    "turn/start": { threadId: {}, input: { type: "array", items: { $ref: "#/definitions/UserInput" } }, model: {}, effort: {}, outputSchema: {} },
    "modelProvider/capabilities/read": {},
    "thread/list": { limit: {}, cursor: {}, sortKey: {}, modelProviders: {}, sourceKinds: {}, archived: {} },
    "thread/read": { threadId: {}, includeTurns: {} },
    "thread/turns/list": { threadId: {}, limit: {}, cursor: {}, sortDirection: { enum: ["asc", "desc"] }, itemsView: { anyOf: [{ $ref: "#/definitions/ItemsView" }, { type: "null" }] } },
  };
  return { definitions: {
    Capabilities: { properties: { experimentalApi: {} } },
    Approval: { oneOf: [{ enum: ["never"] }, { type: "object" }] },
    ItemsView: { oneOf: [{ enum: ["summary"] }, { enum: ["full"] }] },
    UserInput: { oneOf: ["text", "localImage", "skill"].map(type => ({ properties: { type: { enum: [type] } } })) },
  }, oneOf: Object.entries(params).map(([method, properties]) => ({ properties: { method: { enum: [method] }, params: { type: "object", properties } } })) };
}
const parameters = (schema, method) => schema.oneOf.find(node => node.properties.method.enum[0] === method).properties.params.properties;

test("protocol checks capabilities without requiring a latest version number", () => {
  const result = inspectProtocol(protocol());
  assert.deepEqual(Object.values(result).map(item => item.status), ["supported", "supported", "supported", "supported"]);
});

test("missing image tools affect reverse only; legacy embedded sessions remain usable", () => {
  const schema = protocol();
  delete parameters(schema, "thread/start").dynamicTools;
  assert.equal(inspectProtocol(schema).reverse.status, "unsupported");
  assert.equal(inspectProtocol(schema).generation.status, "supported");
  schema.oneOf = schema.oneOf.filter(node => node.properties.method.enum[0] !== "thread/turns/list");
  const result = inspectProtocol(schema);
  assert.equal(result.sessions.status, "supported");
  schema.oneOf = schema.oneOf.filter(node => node.properties.method.enum[0] !== "thread/read");
  result.sessions = inspectProtocol(schema).sessions;
  assert.equal(result.models.status, "supported");
  assert.throws(() => assertFeatureSupported({ features: result }, "sessions"), error => error.recovery === "cli" && error.status === 409);
  assert.doesNotThrow(() => assertFeatureSupported({ features: result }, "generation"));
});

test("missing required security options and local image variant block affected inference", () => {
  const schema = protocol();
  parameters(schema, "thread/start").approvalPolicy = { enum: ["on-request"] };
  assert.equal(inspectProtocol(schema).reverse.status, "unsupported");
  assert.equal(inspectProtocol(schema).generation.status, "unsupported");
  assert.equal(inspectProtocol(schema).sessions.status, "supported");
  const noImage = protocol();
  noImage.definitions.UserInput.oneOf.splice(1, 1);
  assert.equal(inspectProtocol(noImage).reverse.status, "unsupported");
});

test("unrecognized schemas and unresolved references remain unknown and can be tried", () => {
  assert.equal(inspectProtocol({}).reverse.status, "unknown");
  const schema = protocol();
  parameters(schema, "thread/start").approvalPolicy = { $ref: "external.json#type" };
  assert.equal(inspectProtocol(schema).reverse.status, "unknown");
  assert.doesNotThrow(() => assertFeatureSupported({ features: inspectProtocol(schema) }, "reverse"));
});

test("same binary shares one probe; external replacement and explicit recheck invalidate cache", async () => {
  let identity = "first", calls = 0;
  const checker = createCompatibilityChecker({ identify: async () => ({ executable: "/actual/codex", key: identity }), probe: async path => {
    assert.equal(path, "/actual/codex"); calls++; return protocol();
  } });
  await Promise.all([checker.getCompatibility(), checker.getCompatibility()]);
  await checker.getCompatibility();
  assert.equal(calls, 1);
  identity = "external-update";
  await checker.getCompatibility();
  assert.equal(calls, 2);
  await checker.getCompatibility({ force: true });
  assert.equal(calls, 3);
  const snapshot = checker.snapshot();
  snapshot.features.reverse.status = "unsupported";
  assert.equal(checker.snapshot().features.reverse.status, "supported");
});

test("schema command failure is unknown, retries are bounded, and force recovers", async () => {
  let calls = 0, clock = 1_000, failing = true;
  const checker = createCompatibilityChecker({ now: () => clock, identify: async () => ({ executable: "codex", key: "old" }), probe: async () => {
    calls++;
    if (failing) throw new Error("unknown --experimental argument");
    return protocol();
  } });
  const result = await checker.getCompatibility();
  assert.equal(result.features.reverse.status, "unknown");
  assert.ok(result.error);
  await checker.getCompatibility();
  assert.equal(calls, 1);
  clock += 30_000;
  await checker.getCompatibility();
  assert.equal(calls, 2);
  failing = false;
  assert.equal((await checker.getCompatibility({ force: true })).features.reverse.status, "supported");
});

test("missing CLI remains unknown with an actionable installation message", async () => {
  const checker = createCompatibilityChecker({ identify: async () => null, probe: () => assert.fail("must not run") });
  const report = await checker.getCompatibility();
  assert.equal(report.features.models.status, "unknown");
  assert.match(report.error, /安装路径/);
});

test("explicit RPC incompatibilities guide CLI recovery and preserve error identity fields", () => {
  for (const message of ["Method not found", "unknown field `dynamicTools`", "unknown variant `localImage`, expected text"]) {
    const error = codexRpcError(Object.assign(new Error(message), { code: -32602, status: 409 }), "turn/start");
    assert.equal(error.code, -32602);
    assert.equal(error.status, 409);
    assert.equal(error.recovery, "cli");
    assert.match(error.message, /设置中心/);
  }
});

test("invalid params, login, permission, network and model failures never imply CLI incompatibility", () => {
  for (const message of ["Invalid params", "Unauthorized: login required", "EACCES", "Connection reset", "Model not supported for this account", "unknown variant `ultra`, expected low or high"]) {
    const original = Object.assign(new Error(message), { code: -32602 });
    assert.equal(codexRpcError(original, "turn/start"), original);
    assert.equal(original.recovery, undefined);
  }
});
