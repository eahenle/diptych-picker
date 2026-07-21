import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const launcher = join(process.cwd(), "dev-and-play");
const runOnly = join(process.cwd(), "run-only");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

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
    expect(stdout).toContain("./run-only");
  });

  it("rejects a thread count that cannot fit root, monitor, and three workers", async () => {
    await expect(
      execFileAsync(launcher, ["--print-command", "4"]),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/at least 5 threads/i),
    });
  });
});

describe("run-only launcher", () => {
  it("prints an agent-forced production build and start command", async () => {
    const { stdout } = await execFileAsync(runOnly, ["--print-command"]);

    expect(stdout).toContain("NEXT_DIST_DIR=.next-run");
    expect(stdout).toContain("npm run build");
    expect(stdout).toContain("GENERATION_PROVIDER=agent");
    expect(stdout).toContain("npm run start");
    expect(stdout).not.toContain("npm run dev");
  });

  it("restores Next-generated config after building before it starts the server", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-run-only-"));
    temporaryRoots.push(root);
    const copiedLauncher = join(root, "run-only");
    const bin = join(root, "bin");
    const log = join(root, "npm.log");
    await mkdir(bin);
    await copyFile(runOnly, copiedLauncher);
    await chmod(copiedLauncher, 0o755);
    await writeFile(join(root, "next-env.d.ts"), "original\n", "utf8");
    await writeFile(join(root, "tsconfig.json"), "original config\n", "utf8");
    const fakeNpm = join(bin, "npm");
    await writeFile(
      fakeNpm,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$RUN_ONLY_TEST_LOG"',
        'if [ "$1 $2" = "run build" ]; then',
        '  printf "generated\\n" > next-env.d.ts',
        '  printf "generated config\\n" > tsconfig.json',
        "fi",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeNpm, 0o755);

    await execFileAsync(copiedLauncher, [], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUN_ONLY_TEST_LOG: log,
      },
    });

    expect(await readFile(join(root, "next-env.d.ts"), "utf8")).toBe(
      "original\n",
    );
    expect(await readFile(join(root, "tsconfig.json"), "utf8")).toBe(
      "original config\n",
    );
    expect(await readFile(log, "utf8")).toBe("run build\nrun start\n");
  });

  it("rejects unsupported arguments", async () => {
    await expect(execFileAsync(runOnly, ["--watch"])).rejects.toMatchObject({
      stderr: expect.stringMatching(/Usage: \.\/run-only/),
    });
  });

  it("keeps production build output outside formatting and lint scope", async () => {
    const [gitignore, eslintConfig, tsconfig] = await Promise.all([
      readFile(join(process.cwd(), ".gitignore"), "utf8"),
      readFile(join(process.cwd(), "eslint.config.mjs"), "utf8"),
      readFile(join(process.cwd(), "tsconfig.json"), "utf8"),
    ]);

    expect(gitignore).toContain(".next-run/");
    expect(eslintConfig).toContain('".next-run/**"');
    expect(tsconfig).toContain('".next-run/types/**/*.ts"');
  });
});
