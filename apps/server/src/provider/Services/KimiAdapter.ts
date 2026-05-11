/**
 * KimiAdapter — shape type for the Kimi Code CLI provider adapter.
 *
 * @module KimiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface KimiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
