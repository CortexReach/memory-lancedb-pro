export const calls = [];
const recorder = async (params) => { params.assertActive(); calls.push(params); };
export let recordMemoryRecall = recorder;
export function setRecorder(value) { recordMemoryRecall = value; }
export function resetRecorder(mode = "available") {
  calls.length = 0;
  recordMemoryRecall = mode === "missing" ? undefined
    : mode === "failing" ? async () => { throw new Error("synthetic unavailable store"); }
    : recorder;
}
