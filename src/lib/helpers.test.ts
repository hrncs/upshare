import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanIdentifier, formatBytes, formatDuration } from "./format";
import { printError, printFields, printSuccess, printWarning } from "./output";
import { createSpinner } from "./spinner";
import { editDistance, suggestCommand } from "./suggest";
import {
  createTransferProgressLine,
  formatTransferProgressText,
} from "./transfer-progress";
import { parseDurationHours, parseIntegerRange } from "./validation";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("spinner", () => {
  it("uses the shared text-only animation", () => {
    const spinner = createSpinner({ isSilent: true, text: "Working..." });

    expect(spinner.interval).toBe(100);
    expect(spinner.spinner.frames).toEqual(["-", "\\", "|", "/"]);
  });

  it("does not print transient progress when output is redirected", () => {
    const stream = new PassThrough();
    let transientOutput = "";
    stream.on("data", (chunk: Buffer) => {
      transientOutput += chunk.toString();
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    createSpinner({ stream, text: "Working..." })
      .start()
      .succeed("Work complete");

    expect(transientOutput).toBe("");
    expect(
      log.mock.calls.map(([message]) => [
        stripVTControlCharacters(String(message)),
      ])
    ).toEqual([["Work complete"]]);
  });
});

describe("CLI output", () => {
  it("uses prose instead of boxed status labels", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    printSuccess("Uploaded photo.jpg");
    printError("Upload failed");
    printWarning("The upload can be resumed.");

    const output = [...log.mock.calls, ...error.mock.calls, ...warn.mock.calls]
      .flat()
      .map((part) => stripVTControlCharacters(String(part)))
      .join("\n");
    expect(output).toContain("Uploaded photo.jpg");
    expect(output).toContain("Error: Upload failed");
    expect(output).toContain("Warning: The upload can be resumed.");
    for (const forbidden of [
      "[OK]",
      "[ERROR]",
      "[WARN]",
      "[INFO]",
      "\u2714",
      "\u2716",
    ]) {
      expect(output).not.toContain(forbidden);
    }
  });

  it("aligns detail fields without label punctuation", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    printFields([
      ["File", "photo.jpg"],
      ["Expires", "in 24 hours"],
    ]);

    expect(
      log.mock.calls.map(([message]) => [
        stripVTControlCharacters(String(message)),
      ])
    ).toEqual([["  File     photo.jpg"], ["  Expires  in 24 hours"]]);
  });
});

describe("command suggestions", () => {
  const COMMANDS = [
    { aliases: [], name: "login" },
    { aliases: [], name: "whoami" },
    { aliases: [], name: "logout" },
    { aliases: [], name: "upload" },
    { aliases: [], name: "download" },
    { aliases: ["ls"], name: "list" },
    { aliases: [], name: "info" },
    { aliases: [], name: "rename" },
    { aliases: [], name: "abort" },
    { aliases: ["rm"], name: "delete" },
    { aliases: ["files"], name: "manage" },
    { aliases: [], name: "share" },
    { aliases: [], name: "extend" },
    { aliases: [], name: "revoke" },
    { aliases: ["update"], name: "upgrade" },
    { aliases: [], name: "help" },
  ];

  it("counts adjacent transpositions as a single edit", () => {
    expect(editDistance("whomai", "whoami")).toBe(1);
    expect(editDistance("abrot", "abort")).toBe(1);
  });

  it("is case-insensitive", () => {
    expect(editDistance("WhoAmI", "whoami")).toBe(0);
  });

  it("suggests the intended command for common typos", () => {
    expect(suggestCommand("whomai", COMMANDS)).toBe("whoami");
    expect(suggestCommand("uplod", COMMANDS)).toBe("upload");
    expect(suggestCommand("downlod", COMMANDS)).toBe("download");
    expect(suggestCommand("logn", COMMANDS)).toBe("login");
    expect(suggestCommand("abrot", COMMANDS)).toBe("abort");
  });

  it("resolves aliases to their canonical command", () => {
    expect(suggestCommand("LS", COMMANDS)).toBe("list");
    expect(suggestCommand("rm", COMMANDS)).toBe("delete");
  });

  it("returns null when nothing is close", () => {
    expect(suggestCommand("xyz", COMMANDS)).toBeNull();
    expect(suggestCommand("foobar", COMMANDS)).toBeNull();
    expect(suggestCommand("", COMMANDS)).toBeNull();
  });
});

describe("transfer progress", () => {
  it("adapts transfer details before the terminal line can wrap", () => {
    const wide = formatTransferProgressText(
      "Downloading",
      512 * 1024 * 1024,
      1024 * 1024 * 1024,
      16 * 1024 * 1024,
      120
    );
    const narrow = formatTransferProgressText(
      "Downloading",
      512 * 1024 * 1024,
      1024 * 1024 * 1024,
      16 * 1024 * 1024,
      20
    );

    expect(wide).toContain("512 MB / 1 GB");
    expect(wide).toContain("ETA");
    expect(narrow).toBe("Downloading 50.0%");
  });

  it("updates one line without terminal clear sequences", () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1050)
      .mockReturnValueOnce(1100);
    const writes: string[] = [];
    const progress = createTransferProgressLine({
      action: "Uploading",
      output: {
        columns: 80,
        isTTY: true,
        write(text) {
          writes.push(text);
        },
      },
      startedAt: 0,
      totalBytes: 100,
    });

    progress.update(10, 10);
    progress.update(20, 20);
    progress.update(100, 100);
    progress.clear();

    expect(writes).toHaveLength(3);
    expect(writes[0]?.startsWith("\rUploading 10.0%")).toBe(true);
    expect(writes[1]).toContain("100.0%");
    expect(writes.join("")).not.toContain("\u001B");
  });
});

describe("input validation", () => {
  it("uses the fallback only when omitted", () => {
    expect(parseDurationHours(undefined, 24, 1)).toBe(24);
  });

  it.each(["", "1x", "NaN", "0", "169", "Infinity"])(
    "rejects invalid duration %j",
    (value) => {
      expect(() => parseDurationHours(value, 24, 1)).toThrow();
    }
  );

  it("accepts fractional share duration", () => {
    expect(parseDurationHours("0.5", 24, 0.5)).toBe(0.5);
  });

  it("accepts a whole number in range", () => {
    expect(parseIntegerRange("16", 8, 1, 16, "Concurrency")).toBe(16);
  });

  it.each(["", "1.5", "0", "17", "nope"])(
    "rejects invalid integer %j",
    (value) => {
      expect(() => parseIntegerRange(value, 8, 1, 16, "Concurrency")).toThrow();
    }
  );
});

describe("cleanIdentifier", () => {
  it("extracts token from full share URL", () => {
    expect(cleanIdentifier("https://upshare.app/s/abcdef12")).toBe("abcdef12");
  });

  it("strips trailing slash from share URL", () => {
    expect(cleanIdentifier("https://upshare.app/s/abcdef12/")).toBe("abcdef12");
    expect(cleanIdentifier("https://upshare.app/s/abcdef12///")).toBe(
      "abcdef12"
    );
  });

  it("handles query parameters and hashes with trailing slashes", () => {
    expect(
      cleanIdentifier("https://upshare.app/s/abcdef12?download=true")
    ).toBe("abcdef12");
    expect(
      cleanIdentifier("https://upshare.app/s/abcdef12/?download=true")
    ).toBe("abcdef12");
    expect(cleanIdentifier("https://upshare.app/s/abcdef12#preview")).toBe(
      "abcdef12"
    );
  });

  it("strips trailing slash from plain token or fileId", () => {
    expect(cleanIdentifier("abcdef12/")).toBe("abcdef12");
    expect(cleanIdentifier("fil_01h9x3q8k2v4m1/")).toBe("fil_01h9x3q8k2v4m1");
    expect(cleanIdentifier("  fil_01h9x3q8k2v4m1/  ")).toBe(
      "fil_01h9x3q8k2v4m1"
    );
  });

  it("leaves clean token or fileId unchanged", () => {
    expect(cleanIdentifier("abcdef12")).toBe("abcdef12");
    expect(cleanIdentifier("fil_01h9x3q8k2v4m1")).toBe("fil_01h9x3q8k2v4m1");
  });
});

describe("formatBytes", () => {
  it("formats zero bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats kilobytes and megabytes", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(3665)).toBe("1h 1m 5s");
  });
});
