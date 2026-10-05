import test from "node:test";
import assert from "node:assert/strict";
import { readSessionContent } from "../bridge/session-content.mjs";

const source = { id: "11111111-1111-4111-8111-111111111111", updatedAt: 1 };
const turn = id => ({ id, itemsView: "full", items: [{ id: `u${id}`, type: "userMessage", content: [{ type: "text", text: `正文${id}` }] }] });
const tooLarge = () => Object.assign(new Error("response too large"), { code: "RESPONSE_TOO_LARGE" });

test("index retries oversized pages at the same cursor and retains ordered complete text", async () => {
  const calls = [];
  const request = async (method, params) => {
    if (method === "thread/read") return { thread: { ...source, historyMode: "paginated" } };
    calls.push(params);
    if (params.limit > 6) throw tooLarge();
    return params.cursor ? { data: [turn("2")], nextCursor: null } : { data: [turn("1")], nextCursor: "next" };
  };
  const result = await readSessionContent(request, source, { adaptivePageSize: true, maxPages: 2 });
  assert.deepEqual(calls.map(item => item.limit), [50, 25, 12, 6, 6]);
  assert.deepEqual(calls.map(item => item.cursor), [undefined, undefined, undefined, undefined, "next"]);
  assert.deepEqual(result.messages.map(item => item.text), ["正文1", "正文2"]);
});

test("a single oversized turn remains a capacity failure; cancellation stops adaptive retries", async () => {
  const calls = [];
  const request = async (method, params) => {
    if (method === "thread/read") return { thread: { ...source, historyMode: "paginated" } };
    calls.push(params.limit); throw tooLarge();
  };
  await assert.rejects(readSessionContent(request, source, { adaptivePageSize: true }), { code: "RESPONSE_TOO_LARGE" });
  assert.deepEqual(calls, [50, 25, 12, 6, 3, 1]);
  const controller = new AbortController();
  calls.length = 0;
  await assert.rejects(readSessionContent(async (method, params) => {
    if (method === "thread/turns/list") controller.abort();
    return request(method, params);
  }, source, { adaptivePageSize: true, signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(calls, [50]);
});

test("creative capture does not opt into page retries and limits retain stable codes", async () => {
  let calls = 0;
  const request = async method => {
    if (method === "thread/read") return { thread: { ...source, historyMode: "paginated" } };
    calls++; throw tooLarge();
  };
  await assert.rejects(readSessionContent(request, source), { code: "RESPONSE_TOO_LARGE" });
  assert.equal(calls, 1);
  const paginated = async method => method === "thread/read" ? { thread: { ...source, historyMode: "paginated" } }
    : { data: [turn("1")], nextCursor: "next" };
  await assert.rejects(readSessionContent(paginated, source, { maxCharacters: 1 }), { code: "CONTENT_LIMIT" });
  await assert.rejects(readSessionContent(paginated, source, { maxPages: 1 }), { code: "PAGE_LIMIT" });
  await assert.rejects(readSessionContent(async () => ({ thread: { ...source, updatedAt: 2 } }), source), { code: "SESSION_CHANGED" });
});
