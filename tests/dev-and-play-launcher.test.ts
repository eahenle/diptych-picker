import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const launcher = join(process.cwd(), "dev-and-play");

describe("dev-and-play launcher", () => {
  it("prints a capacity and nesting override with the skill prompt", async () => {
    const { stdout } = await execFileAsync(launcher, ["--print-command", "12"]);

    expect(stdout).toContain("multi-cli codex/personal");
    expect(stdout).toContain("features.multi_agent_v2=");
    expect(stdout).toContain("enabled=true");
    expect(stdout).toContain("max_concurrent_threads_per_session=12");
    expect(stdout).not.toContain("agents.max_threads=");
    expect(stdout).toContain("agents.max_depth=2");
    expect(stdout).toContain(`--cd ${process.cwd()}`);
    expect(stdout).toContain("\\$run-diptych-picker");
    expect(stdout).toContain("workerLimit=3");
  });

  it("rejects a thread count that cannot fit root, monitor, and three workers", async () => {
    await expect(
      execFileAsync(launcher, ["--print-command", "4"]),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/at least 5 threads/i),
    });
  });
});
