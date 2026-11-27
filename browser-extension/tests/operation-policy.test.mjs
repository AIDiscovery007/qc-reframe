import test from "node:test";
import assert from "node:assert/strict";
import { operationFor, allowsOperation, messageSource, bridgeTimeout } from "../lib/operation-policy.ts";

test("only this extension's pages and top-frame web content acquire an operation source", () => {
  const source = sender => messageSource(sender, "test", "chrome-extension://test/");
  assert.equal(source({ id: "test", url: "chrome-extension://test/workspace.html" }), "extension");
  assert.equal(source({ id: "test", frameId: 0, tab: { id: 0, url: "https://example.com/" } }), "content");
  for (const sender of [undefined, {},
    { id: "other", url: "chrome-extension://test/workspace.html" },
    { id: "test", url: "chrome-extension://test.evil/workspace.html" },
    { id: "test", url: "https://example.com/" },
    { id: "test", frameId: 1, tab: { id: 1, url: "https://example.com/" } },
    { id: "test", frameId: 0, tab: { id: 1, url: "file:///private/data" } },
  ]) assert.equal(source(sender), undefined);
});

test("session requests cannot inherit UI or object-prototype permissions; legacy one-shot calls remain supported", () => {
  for (const type of ["alchemy:sessions-list", "alchemy:sessions-index"]) {
    const operation = operationFor(type);
    for (const transport of ["message", "port"]) {
      assert.equal(allowsOperation(operation, "extension", transport), true);
      assert.equal(allowsOperation(operation, "content", transport), false);
      assert.equal(allowsOperation(operation, undefined, transport), false);
    }
  }
  for (const type of ["constructor", "toString", "__proto__", "alchemy:unknown", null, { toString: () => "alchemy:start" }])
    assert.equal(operationFor(type), undefined);
  assert.equal(allowsOperation(operationFor("alchemy:start"), "content", "port"), true);
  assert.equal(allowsOperation(operationFor("alchemy:state"), "content", "message"), true);
  assert.equal(allowsOperation(operationFor("alchemy:query"), "extension", "port"), false);
  assert.equal(allowsOperation(operationFor("alchemy:collect"), "extension"), false);
});

test("bridge keeps slow read/write deadlines separate from management and ordinary requests", () => {
  for (const path of ["/sessions/list", "/sessions/index", "/projects/project/input", "/jobs"]) assert.equal(bridgeTimeout(path), 120_000);
  for (const path of ["/models/verify", "/cli/update", "/agents?detect=1"]) assert.equal(bridgeTimeout(path), 30_000);
  for (const path of ["/health", "/projects", "/jobs/job/generations", "/agents"]) assert.equal(bridgeTimeout(path), 15_000);
});

test("user's plugin instruction can be read and changed only from Reframe's own pages", () => {
  // Given the settings messages for the plugin instruction.
  for (const type of ["alchemy:plugin-instructions", "alchemy:plugin-instructions-save"]) {
    const operation = operationFor(type);
    // Then extension pages may call them, and web content cannot.
    assert.equal(allowsOperation(operation, "extension"), true);
    assert.equal(allowsOperation(operation, "content"), false);
  }
});
