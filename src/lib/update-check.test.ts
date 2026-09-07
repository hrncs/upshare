import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isNewerVersion, printVersionWithUpdateCheck } from "./update-check";

function mockRegistry(version: unknown) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    json: async () => version,
    ok: true,
  } as Response);
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isNewerVersion", () => {
  it("compares dotted versions part by part", () => {
    expect(isNewerVersion("0.0.12", "0.0.13")).toBe(true);
    expect(isNewerVersion("0.0.13", "0.0.13")).toBe(false);
    expect(isNewerVersion("0.0.13", "0.0.12")).toBe(false);
  });
});

describe("printVersionWithUpdateCheck", () => {
  it("shows the banner when a newer version exists", async () => {
    mockRegistry({ version: "9.9.9" });

    await printVersionWithUpdateCheck("0.0.13");

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("0.0.13");
    expect(output).toContain("Update available");
    expect(output).toContain("upshare upgrade");
  });

  it("prints only the version when already latest", async () => {
    mockRegistry({ version: "0.0.13" });

    await printVersionWithUpdateCheck("0.0.13");

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("0.0.13");
    expect(output).not.toContain("Update available");
  });

  it("prints only the version when offline", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await expect(
      printVersionWithUpdateCheck("0.0.13")
    ).resolves.toBeUndefined();
    expect(vi.mocked(console.log)).toHaveBeenCalledWith("0.0.13");
  });
});
