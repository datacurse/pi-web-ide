import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Explicitly requested sharing only. Secret gists are unlisted, not private. */
export async function shareSessionHtml(content: string): Promise<string> {
  try {
    await exec("gh", ["auth", "status"], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error(
      "Sharing requires GitHub CLI (gh) and a login. Run gh auth login on this machine.",
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "pwi-share-"));
  try {
    const path = join(dir, "session.html");
    await writeFile(path, content, { mode: 0o600 });
    const { stdout } = await exec(
      "gh",
      ["gist", "create", "--public=false", path],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    const url = stdout.trim();
    if (!/^https:\/\/gist\.github\.com\/[^\s]+$/.test(url))
      throw new Error("GitHub did not return a gist URL.");
    return url;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
