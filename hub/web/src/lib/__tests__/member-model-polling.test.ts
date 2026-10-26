import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api";
import { useChangePolling } from "../../queries";

const harness = vi.hoisted(() => ({ effects: [] as (() => unknown)[], invalidateQueries: vi.fn() }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useEffect: (effect: () => unknown) => harness.effects.push(effect) }));
vi.mock("@tanstack/react-query", async (original) => ({ ...await original<typeof import("@tanstack/react-query")>(), useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }) }));

beforeEach(() => {
  harness.effects.length = 0;
  harness.invalidateQueries.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("window", { clearTimeout: vi.fn(), setTimeout: vi.fn(() => 1), addEventListener: vi.fn() });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

it("reuses change polling to refresh only active member model queries on unchanged sequence", async () => {
  vi.spyOn(api, "changes").mockResolvedValue(null);
  useChangePolling();
  harness.effects[0]!();
  await Promise.resolve();
  await Promise.resolve();
  expect(harness.invalidateQueries).toHaveBeenCalled();
  const options = harness.invalidateQueries.mock.calls[0]![0];
  const query = (key: string, active = true) => ({ queryKey: [key], isActive: () => active });
  expect(options.predicate(query("members"))).toBe(true);
  expect(options.predicate(query("member"))).toBe(true);
  expect(options.predicate(query("members", false))).toBe(false);
  expect(options.predicate(query("thread"))).toBe(false);
  expect(options.predicate(query("thread-live"))).toBe(false);
});

it("keeps member refresh paused while the document is hidden", async () => {
  vi.stubGlobal("document", { visibilityState: "hidden", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const changes = vi.spyOn(api, "changes").mockResolvedValue(null);
  useChangePolling();
  harness.effects[0]!();
  await Promise.resolve();
  expect(changes).not.toHaveBeenCalled();
  expect(harness.invalidateQueries).not.toHaveBeenCalled();
});
