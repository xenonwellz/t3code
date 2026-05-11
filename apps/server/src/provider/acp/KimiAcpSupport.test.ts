import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  applyKimiAcpModelSelection,
  buildKimiAcpSpawnInput,
  resolveKimiAcpModelIdForPrompt,
} from "./KimiAcpSupport.ts";

describe("buildKimiAcpSpawnInput", () => {
  it("builds the default Kimi ACP command", () => {
    expect(buildKimiAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "kimi",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("parses launchArgs before the acp subcommand", () => {
    expect(
      buildKimiAcpSpawnInput({ binaryPath: "/opt/kimi", launchArgs: "  --verbose  " }, "/repo", {
        FOO: "bar",
      }),
    ).toEqual({
      command: "/opt/kimi",
      args: ["--verbose", "acp"],
      cwd: "/repo",
      env: { FOO: "bar" },
    });
  });
});

describe("resolveKimiAcpModelIdForPrompt", () => {
  it("appends ,thinking when the thinking option is true", () => {
    expect(resolveKimiAcpModelIdForPrompt("k2", [{ id: "thinking", value: true }])).toBe(
      "k2,thinking",
    );
  });

  it("strips an existing thinking suffix before re-applying", () => {
    expect(resolveKimiAcpModelIdForPrompt("k2,thinking", [{ id: "thinking", value: false }])).toBe(
      "k2",
    );
  });

  it("uses k2 when model is empty", () => {
    expect(resolveKimiAcpModelIdForPrompt(null, [])).toBe("k2");
  });
});

describe("applyKimiAcpModelSelection", () => {
  it("calls setModel with the resolved id", async () => {
    const models: string[] = [];
    await Effect.runPromise(
      applyKimiAcpModelSelection({
        runtime: {
          setSessionModel: (modelId) =>
            Effect.sync(() => {
              models.push(modelId);
            }),
        },
        model: "moonshot-v1",
        selections: [{ id: "thinking", value: true }],
        mapError: ({ cause }) => cause.message,
      }),
    );
    expect(models).toEqual(["moonshot-v1,thinking"]);
  });
});
