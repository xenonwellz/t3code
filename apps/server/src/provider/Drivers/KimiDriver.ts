/**
 * KimiDriver — `ProviderDriver` for Kimi Code CLI (`kimi acp`).
 *
 * @module provider/Drivers/KimiDriver
 */
import { KimiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { makeKimiTextGeneration } from "../../textGeneration/KimiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeKimiAdapter } from "../Layers/KimiAdapter.ts";
import {
  buildInitialKimiProviderSnapshot,
  checkKimiProviderStatus,
} from "../Layers/KimiProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilitiesResolver,
} from "../providerMaintenance.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);

const DRIVER_KIND = ProviderDriverKind.make("kimi");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const MAINTENANCE_RESOLVER: ProviderMaintenanceCapabilitiesResolver = {
  resolve: () =>
    makeManualOnlyProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: "kimi-cli",
    }),
};

export type KimiDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const KimiDriver: ProviderDriver<KimiSettings, KimiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Kimi",
    supportsMultipleInstances: true,
  },
  configSchema: KimiSettings,
  defaultConfig: (): KimiSettings => decodeKimiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      yield* FileSystem.FileSystem;
      yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const eventLoggers = yield* ProviderEventLoggers;
      const serverConfig = yield* Effect.service(ServerConfig);
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies KimiSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
        MAINTENANCE_RESOLVER,
        {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        },
      );

      const adapter = yield* makeKimiAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeKimiTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkKimiProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        processEnv,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedServerProvider<KimiSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          buildInitialKimiProviderSnapshot(settings).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Kimi snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
