import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// One backend serves the built UI on :8890 and Vite proxies its API there.
// Never automatically evict another runner (especially a restarting service).
export function devEnvironment(env = process.env) {
  return {
    ...env,
    PWI_PORT: env.PWI_PORT ?? "8890",
    PWI_TAKEOVER: env.PWI_TAKEOVER ?? "0",
  };
}

/** A TCP connection alone may belong to the server we are replacing. */
export async function serverBoot(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return undefined;
    const health = await response.json();
    return health?.ok === true &&
      health.product === "pi-web-ide" &&
      typeof health.boot === "string" &&
      health.boot.length > 0
      ? health.boot
      : undefined;
  } catch {
    return undefined;
  }
}

export async function waitForServer(port, previousBoot, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const boot = await serverBoot(port);
    if (boot && boot !== previousBoot) return;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(
    `backend on port ${port} did not become ready within ${timeoutMs / 1_000}s`,
  );
}

async function main() {
  const env = devEnvironment();
  const port = env.PWI_PORT;
  if (process.argv[2] === "wait") {
    await waitForServer(port, process.env.PWI_PREVIOUS_BOOT);
    return;
  }

  // Snapshot BEFORE either concurrent process starts, so the old server
  // cannot satisfy readiness during slow version probing or takeover.
  const previousBoot = await serverBoot(port);
  const child = spawn(
    "pnpm",
    [
      "exec",
      "concurrently",
      "-k",
      "-n",
      "server,web",
      "-c",
      "blue,green",
      "pnpm:dev:server",
      "pnpm:dev:web",
    ],
    {
      stdio: "inherit",
      env: { ...env, PWI_PREVIOUS_BOOT: previousBoot ?? "" },
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`[pwi] ${error.message}`);
    process.exitCode = 1;
  });
}
