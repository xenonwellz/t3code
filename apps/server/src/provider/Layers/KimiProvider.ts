import type {
  KimiSettings,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as Schema from "effect/Schema";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { makeKimiAcpRuntime } from "../acp/KimiAcpSupport.ts";

const PROVIDER = ProviderDriverKind.make("kimi");
const KIMI_PRESENTATION = {
  displayName: "Kimi",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const KIMI_PROBE_TIMEOUT_MS = 25_000;
const KIMI_VERSION_TIMEOUT_MS = 8_000;

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

function isAcpAuthRequiredError(error: unknown): boolean {
  return isAcpRequestError(error) && error.code === -32_000;
}

export function buildInitialKimiProviderSnapshot(
  kimiSettings: KimiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getKimiFallbackModels(kimiSettings);

    if (!kimiSettings.enabled) {
      return buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kimi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Kimi Code CLI availability...",
      },
    });
  });
}

function getKimiFallbackModels(kimiSettings: KimiSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], PROVIDER, kimiSettings.customModels, EMPTY_CAPABILITIES);
}

function kimiModelsFromSessionModels(
  models: EffectAcpSchema.SessionModelState,
): ReadonlyArray<ServerProviderModel> {
  return models.availableModels.map((entry) => ({
    slug: entry.modelId.trim(),
    name: entry.name.trim(),
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  }));
}

const withKimiAcpProbeRuntime = <A, E, R>(
  kimiSettings: KimiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  useRuntime: (acp: AcpSessionRuntimeShape) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeKimiAcpRuntime({
      childProcessSpawner: spawner,
      kimiSettings,
      environment,
      cwd,
      clientInfo: { name: "t3-code-kimi-probe", version: "0.0.0" },
    });
    return yield* useRuntime(acp);
  }).pipe(Effect.scoped);

export const discoverKimiModelsViaAcp = (
  kimiSettings: KimiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  withKimiAcpProbeRuntime(kimiSettings, cwd, environment, (acp) =>
    Effect.gen(function* () {
      const started = yield* acp.start();
      const modelState = started.sessionSetupResult.models;
      if (!modelState) {
        return [] as const;
      }
      return kimiModelsFromSessionModels(modelState);
    }),
  );

const runKimiVersionCommand = (kimiSettings: KimiSettings, environment: NodeJS.ProcessEnv) =>
  spawnAndCollect(
    kimiSettings.binaryPath,
    ChildProcess.make(kimiSettings.binaryPath, ["--version"], {
      env: { ...process.env, ...environment },
      shell: process.platform === "win32",
    }),
  );

export function buildKimiProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly kimiSettings: KimiSettings;
  readonly version: string | null;
  readonly auth: ServerProviderAuth;
  readonly status: Exclude<ServerProvider["status"], "disabled">;
  readonly message?: string;
  readonly discoveredModels: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const parts = [input.message, input.discoveryWarning]
    .map((m) => m?.trim())
    .filter((m): m is string => Boolean(m));
  const message = parts.length > 0 ? parts.join(" ") : undefined;
  return buildServerProvider({
    presentation: KIMI_PRESENTATION,
    enabled: input.kimiSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels,
      PROVIDER,
      input.kimiSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version: input.version,
      status: input.discoveryWarning && input.status === "ready" ? "warning" : input.status,
      auth: input.auth,
      ...(message ? { message } : {}),
    },
  });
}

export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(function* (
  kimiSettings: KimiSettings,
  probeCwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = getKimiFallbackModels(kimiSettings);

  if (!kimiSettings.enabled) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kimi is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* Effect.result(
    runKimiVersionCommand(kimiSettings, environment).pipe(
      Effect.timeoutOption(KIMI_VERSION_TIMEOUT_MS),
    ),
  );

  if (versionProbe._tag === "Failure") {
    const squashed = Cause.squash(Cause.fail(versionProbe.failure));
    const message =
      squashed instanceof Error ? squashed.message : String(squashed ?? "unknown error");
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause({ message }),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause({ message })
          ? "Kimi Code CLI (`kimi`) is not installed or not on PATH."
          : `Failed to execute Kimi CLI health check: ${message}.`,
      },
    });
  }

  const versionInner = versionProbe.success;
  if (Option.isNone(versionInner)) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code CLI is installed but `kimi --version` timed out.",
      },
    });
  }

  const versionText = `${versionInner.value.stdout}\n${versionInner.value.stderr}`;
  const cliVersion = parseGenericCliVersion(versionText);

  const discoveryExit = yield* Effect.exit(
    discoverKimiModelsViaAcp(kimiSettings, probeCwd, environment).pipe(
      Effect.timeoutOption(KIMI_PROBE_TIMEOUT_MS),
    ),
  );

  if (Exit.isFailure(discoveryExit)) {
    const squashedFailure = Cause.squash(discoveryExit.cause);
    if (isAcpAuthRequiredError(squashedFailure)) {
      return buildKimiProviderSnapshot({
        checkedAt,
        kimiSettings,
        version: cliVersion,
        auth: { status: "unauthenticated" },
        status: "ready",
        message: "Run `kimi login` in a terminal, then refresh this provider.",
        discoveredModels: [],
      });
    }
    yield* Effect.logWarning("Kimi ACP model discovery failed", {
      cause: Cause.pretty(discoveryExit.cause),
    });
    return buildKimiProviderSnapshot({
      checkedAt,
      kimiSettings,
      version: cliVersion,
      auth: { status: "unknown" },
      status: "error",
      message: "Kimi ACP probe failed. Check that `kimi acp` runs and you are logged in.",
      discoveredModels: [],
    });
  }

  const timed = discoveryExit.value;
  if (Option.isNone(timed)) {
    return buildKimiProviderSnapshot({
      checkedAt,
      kimiSettings,
      version: cliVersion,
      auth: { status: "unknown" },
      status: "warning",
      message: `Kimi ACP discovery timed out after ${KIMI_PROBE_TIMEOUT_MS}ms.`,
      discoveredModels: [],
    });
  }

  const discovered = timed.value;
  if (discovered.length === 0) {
    return buildKimiProviderSnapshot({
      checkedAt,
      kimiSettings,
      version: cliVersion,
      auth: { status: "authenticated" },
      status: "warning",
      message: "Kimi responded but reported no models. Check your Kimi config.",
      discoveredModels: [],
    });
  }

  return buildKimiProviderSnapshot({
    checkedAt,
    kimiSettings,
    version: cliVersion,
    auth: { status: "authenticated" },
    status: "ready",
    discoveredModels: discovered,
  });
});
