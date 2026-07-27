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
const demoOnly = join(process.cwd(), "demo-only");
const testE2e = join(process.cwd(), "test-e2e");
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

    expect(stdout).toMatch(/^codex /);
    expect(stdout).toContain("agents.max_concurrent_threads_per_session=11");
    expect(stdout).not.toContain("multi-cli");
    expect(stdout).not.toContain("codex/personal");
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
    expect(stdout).toContain("--hostname 127.0.0.1");
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
    expect(await readFile(log, "utf8")).toBe(
      "run build\nrun start -- --hostname 127.0.0.1\n",
    );
  });

  it("rejects unsupported arguments", async () => {
    await expect(execFileAsync(runOnly, ["--watch"])).rejects.toMatchObject({
      stderr: expect.stringMatching(/Usage: \.\/run-only/),
    });
  });

  it("keeps isolated build output outside formatting and lint scope", async () => {
    const [gitignore, eslintConfig, tsconfig] = await Promise.all([
      readFile(join(process.cwd(), ".gitignore"), "utf8"),
      readFile(join(process.cwd(), "eslint.config.mjs"), "utf8"),
      readFile(join(process.cwd(), "tsconfig.json"), "utf8"),
    ]);

    expect(gitignore).toContain(".next-run/");
    expect(gitignore).toContain(".next-demo/");
    expect(eslintConfig).toContain('".next-run/**"');
    expect(eslintConfig).toContain('".next-demo/**"');
    expect(tsconfig).toContain('".next-run/types/**/*.ts"');
    expect(tsconfig).toContain('".next-demo/types/**/*.ts"');
  });
});

describe("demo-only launcher", () => {
  it("prints an offline, loopback-only production command", async () => {
    const { stdout } = await execFileAsync(demoOnly, ["--print-command"]);

    expect(stdout).toContain("NEXT_DIST_DIR=.next-demo");
    expect(stdout).toContain("LOCAL_DATA_DIR=.local-data/demo");
    expect(stdout).toContain("GENERATION_PROVIDER=mock");
    expect(stdout).toContain("DIPTYCH_OFFLINE_DEMO=true");
    expect(stdout).toContain("npm run build");
    expect(stdout).toContain("npm run start");
    expect(stdout).toContain("--hostname 127.0.0.1");
    expect(stdout).not.toContain("codex");
  });

  it("rejects unsupported arguments", async () => {
    await expect(execFileAsync(demoOnly, ["--watch"])).rejects.toMatchObject({
      stderr: expect.stringMatching(/Usage: \.\/demo-only/),
    });
  });
});

describe("test-e2e launcher", () => {
  it("restores Next-generated config after Playwright exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-test-e2e-"));
    temporaryRoots.push(root);
    const copiedLauncher = join(root, "test-e2e");
    const playwright = join(root, "node_modules", ".bin", "playwright");
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    await copyFile(testE2e, copiedLauncher);
    await chmod(copiedLauncher, 0o755);
    await writeFile(join(root, "next-env.d.ts"), "original\n", "utf8");
    await writeFile(join(root, "tsconfig.json"), "original config\n", "utf8");
    await writeFile(
      playwright,
      [
        "#!/bin/sh",
        'printf "generated\\n" > next-env.d.ts',
        'printf "generated config\\n" > tsconfig.json',
      ].join("\n"),
      "utf8",
    );
    await chmod(playwright, 0o755);

    await execFileAsync(copiedLauncher);

    expect(await readFile(join(root, "next-env.d.ts"), "utf8")).toBe(
      "original\n",
    );
    expect(await readFile(join(root, "tsconfig.json"), "utf8")).toBe(
      "original config\n",
    );
  });
});
