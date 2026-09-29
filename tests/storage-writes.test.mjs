import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./load-ts.mjs";

function delayedDatabase({ failFirstWrite = false } = {}) {
  const rows = new Map();
  let opens = 0;
  let writes = 0;
  return {
    open() {
      const request = {};
      const delay = ++opens === 1 ? 20 : 0;
      request.result = {
        close() {},
        transaction() {
          const transaction = {};
          const perform = (action, write) => {
            const operation = {};
            const fail = write && ++writes === 1 && failFirstWrite;
            setTimeout(() => {
              if (fail) {
                operation.error = transaction.error = new Error("write failed");
                operation.onerror?.();
                transaction.onabort?.();
                return;
              }
              const result = action();
              operation.result = result.value;
              operation.onsuccess?.();
              // A successful request is not yet a committed transaction.
              setTimeout(() => {
                result.commit?.();
                transaction.oncomplete?.();
              }, 5);
            }, 0);
            return operation;
          };
          transaction.objectStore = () => ({
            put: (value) => {
              const snapshot = structuredClone(value);
              return perform(() => ({ value: snapshot.id, commit: () => rows.set(snapshot.id, snapshot) }), true);
            },
            delete: (id) => perform(() => ({ commit: () => rows.delete(id) }), true),
            clear: () => perform(() => ({ commit: () => rows.clear() }), true),
            getAll: () => perform(() => ({ value: [...rows.values()].map((row) => structuredClone(row)) }), false),
          });
          return transaction;
        },
      };
      setTimeout(() => request.onsuccess?.(), delay);
      return request;
    },
  };
}

test("rapid conversation saves finish in order and reads wait for the final committed prompt", async () => {
  const { saveConversation, listConversations, deleteConversation } = loadTs("app/lib/storage.ts", {
    indexedDB: delayedDatabase(),
  });
  const old = { id: "chat", updatedAt: 1, settings: { systemPrompt: "old", authorNote: "old" }, messages: [] };
  const latest = { ...old, updatedAt: 2, settings: { systemPrompt: "final", authorNote: "final note" } };
  const saves = [saveConversation(old, false), saveConversation(latest, false)];
  const stored = await listConversations();
  await Promise.all(saves);
  assert.deepEqual(stored, [latest]);
  const pendingSave = saveConversation(old, false);
  const pendingDelete = deleteConversation("chat");
  await Promise.all([pendingSave, pendingDelete]);
  assert.deepEqual(await listConversations(), []);
});

test("a failed write does not prevent the next prompt save from committing", async () => {
  const { saveConversation, listConversations } = loadTs("app/lib/storage.ts", {
    indexedDB: delayedDatabase({ failFirstWrite: true }),
  });
  const latest = { id: "chat", updatedAt: 2, settings: { systemPrompt: "recovered" }, messages: [] };
  const results = await Promise.allSettled([
    saveConversation({ ...latest, updatedAt: 1 }, false),
    saveConversation(latest, false),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.deepEqual(await listConversations(), [latest]);
});
