import { type KimiSettings, type ProviderOptionSelection } from "@t3tools/contracts";
import { getProviderOptionBooleanSelectionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

type KimiAcpRuntimeKimiSettings = Pick<KimiSettings, "binaryPath" | "launchArgs">;

export interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildKimiAcpSpawnInput(
  kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  const extraArgs =
    kimiSettings?.launchArgs
      ?.trim()
      .split(/\s+/)
      .filter((token) => token.length > 0) ?? [];
  return {
    command: kimiSettings?.binaryPath || "kimi",
    args: [...extraArgs, "acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeKimiAcpRuntime = (
  input: KimiAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment),
        authMethodId: "login",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

export function resolveKimiAcpModelIdForPrompt(
  model: string | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): string {
  const thinking = getProviderOptionBooleanSelectionValue(selections, "thinking") === true;
  const raw = model?.trim() ?? "";
  const base = raw.replace(/,thinking$/i, "");
  const effectiveBase = base.length > 0 ? base : "k2";
  return thinking ? `${effectiveBase},thinking` : effectiveBase;
}

export function applyKimiAcpModelSelection<E>(input: {
  /** Kimi implements `session/set_model`, not `session/set_config_option` for the active model. */
  readonly runtime: Pick<AcpSessionRuntimeShape, "setSessionModel">;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: { cause: EffectAcpErrors.AcpError }) => E;
}): Effect.Effect<void, E> {
  return input.runtime
    .setSessionModel(resolveKimiAcpModelIdForPrompt(input.model, input.selections))
    .pipe(Effect.mapError((cause) => input.mapError({ cause })));
}
