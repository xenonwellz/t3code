import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Prefer the same runtime as this script (Bun when invoked via `bun scripts/run-dev.mjs`). */
function resolveRunnerCommand() {
  return process.versions.bun ? process.execPath : "bun";
}

const runnerCommand = resolveRunnerCommand();

/** @type {import("node:child_process").ChildProcess[]} */
const children = [];

function spawnScript(scriptName) {
  const child = spawn(runnerCommand, ["run", scriptName], {
    cwd: desktopDir,
    stdio: "inherit",
    env: process.env,
  });
  children.push(child);
  return child;
}

const bundle = spawnScript("dev:bundle");
const electron = spawnScript("dev:electron");

let shuttingDown = false;

function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(exitCode), 800).unref();
}

process.once("SIGINT", () => shutdown(130));
process.once("SIGTERM", () => shutdown(143));
process.once("SIGHUP", () => shutdown(129));

function forwardSiblingExit(other, code, signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  const exitCode =
    signal !== null ? 1 : typeof code === "number" && Number.isFinite(code) ? code : 1;
  if (other.exitCode === null && other.signalCode === null) {
    other.kill("SIGTERM");
  }
  other.once("exit", () => process.exit(exitCode));
}

bundle.once("exit", (code, signal) => forwardSiblingExit(electron, code, signal));
electron.once("exit", (code, signal) => forwardSiblingExit(bundle, code, signal));
