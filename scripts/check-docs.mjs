#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = process.cwd();
const failures = [];
let featureCount = 0;

const requiredFiles = [
  "README.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "LICENSE",
  "docs/README.md",
  "docs/GETTING_STARTED.md",
  "docs/USER_GUIDE.md",
  "docs/AGENT_MODE.md",
  "docs/CONFIGURATION.md",
  "docs/DATA_AND_RECOVERY.md",
  "docs/API.md",
  "docs/FEATURE_MATRIX.md",
  "docs/RELEASE_CHECKLIST.md",
  "examples/README.md",
  "examples/feature-scenarios.md",
  "examples/api/status.sh",
  "examples/api/select.sh",
  "examples/api/set-rules.sh",
  "examples/api/export-save.sh",
  "examples/api/restore-save.sh",
  "examples/api/favorite.sh",
  "examples/api/source-profile.sh",
  "examples/configurations/agent.env.example",
  "examples/configurations/generated-initial-pair.env.example",
  "examples/configurations/co-proc.env.example",
];

for (const path of requiredFiles) {
  if (!existsSync(join(root, path)))
    failures.push(`Missing required file: ${path}`);
}

function walk(directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name.startsWith(".next") ||
      entry.name === ".local-data" ||
      entry.name === "output"
    ) {
      continue;
    }
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...walk(absolute));
    else paths.push(absolute);
  }
  return paths;
}

const markdownFiles = walk(root).filter((path) => extname(path) === ".md");

function headingSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

const headingCache = new Map();
function headingsFor(path) {
  if (headingCache.has(path)) return headingCache.get(path);
  const slugs = new Set();
  if (existsSync(path) && statSync(path).isFile()) {
    const contents = readFileSync(path, "utf8");
    for (const match of contents.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
      slugs.add(headingSlug(match[1]));
    }
  }
  headingCache.set(path, slugs);
  return slugs;
}

for (const markdownPath of markdownFiles) {
  const contents = readFileSync(markdownPath, "utf8");
  const displayPath = relative(root, markdownPath);
  for (const match of contents.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    if (
      /^(?:https?:|mailto:|data:)/i.test(target) ||
      target === "" ||
      target.startsWith("/")
    ) {
      continue;
    }

    const [rawPath, rawFragment] = target.split("#", 2);
    const decodedPath = decodeURIComponent(rawPath);
    const resolvedPath = decodedPath
      ? resolve(dirname(markdownPath), decodedPath)
      : markdownPath;

    if (!existsSync(resolvedPath)) {
      failures.push(`${displayPath}: broken local link ${target}`);
      continue;
    }

    if (rawFragment && statSync(resolvedPath).isFile()) {
      const fragment = decodeURIComponent(rawFragment).toLowerCase();
      if (!headingsFor(resolvedPath).has(fragment)) {
        failures.push(`${displayPath}: missing heading for ${target}`);
      }
    }
  }
  for (const match of contents.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
    try {
      JSON.parse(match[1]);
    } catch (error) {
      const lines = match[1].split("\n").filter((line) => line.trim() !== "");
      try {
        if (lines.length < 2) throw error;
        for (const line of lines) JSON.parse(line);
      } catch {
        failures.push(
          `${displayPath}: invalid JSON example (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  }
}

const matrixPath = join(root, "docs/FEATURE_MATRIX.md");
const scenariosPath = join(root, "examples/feature-scenarios.md");
if (existsSync(matrixPath) && existsSync(scenariosPath)) {
  const matrix = readFileSync(matrixPath, "utf8");
  const scenarios = readFileSync(scenariosPath, "utf8");
  const matrixRows = [...matrix.matchAll(/^\|\s*(DP-\d{3})\s*\|(.+)$/gm)].map(
    (match) => ({ id: match[1], row: match[0] }),
  );
  featureCount = matrixRows.length;
  const scenarioMatches = [
    ...scenarios.matchAll(/^##\s+(DP-\d{3})\s+[—-]\s+(.+)$/gm),
  ];
  const matrixIds = matrixRows.map(({ id }) => id);
  const scenarioIds = scenarioMatches.map((match) => match[1]);
  if (matrixIds.length === 0) {
    failures.push("Feature matrix must contain at least one DP-### row");
  }

  for (const [label, ids] of [
    ["feature matrix", matrixIds],
    ["feature scenarios", scenarioIds],
  ]) {
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length > 0) {
      failures.push(
        `${label} has duplicate IDs: ${[...new Set(duplicates)].join(", ")}`,
      );
    }
  }

  const missingScenarios = matrixIds.filter((id) => !scenarioIds.includes(id));
  const missingMatrixRows = scenarioIds.filter((id) => !matrixIds.includes(id));
  if (missingScenarios.length > 0) {
    failures.push(
      `Matrix IDs without scenarios: ${missingScenarios.join(", ")}`,
    );
  }
  if (missingMatrixRows.length > 0) {
    failures.push(
      `Scenario IDs without matrix rows: ${missingMatrixRows.join(", ")}`,
    );
  }

  const numbers = matrixIds.map((id) => Number(id.slice(3)));
  const expected = Array.from(
    { length: Math.max(0, ...numbers) },
    (_value, index) => index + 1,
  );
  if (numbers.join(",") !== expected.join(",")) {
    failures.push(
      "Feature matrix IDs must be ordered and contiguous from DP-001",
    );
  }

  for (const { id, row } of matrixRows) {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 5) {
      failures.push(
        `${id}: expected five matrix columns, received ${cells.length}`,
      );
      continue;
    }
    if (!cells[2].includes("](") || !cells[3].includes("](")) {
      failures.push(`${id}: documentation and example columns must be links`);
    }
    const evidence = [...cells[4].matchAll(/`([^`]+)`/g)].map(
      (match) => match[1],
    );
    if (evidence.length === 0) {
      failures.push(`${id}: automated evidence is required`);
    }
    for (const evidencePath of evidence) {
      if (!existsSync(join(root, evidencePath))) {
        failures.push(`${id}: missing automated evidence ${evidencePath}`);
      }
    }
  }

  for (let index = 0; index < scenarioMatches.length; index += 1) {
    const start =
      scenarioMatches[index].index + scenarioMatches[index][0].length;
    const end =
      index + 1 < scenarioMatches.length
        ? scenarioMatches[index + 1].index
        : scenarios.length;
    if (scenarios.slice(start, end).trim().length < 80) {
      failures.push(
        `${scenarioMatches[index][1]}: scenario is too short to reproduce`,
      );
    }
  }
}

for (const scriptPath of requiredFiles.filter((path) => path.endsWith(".sh"))) {
  const absolute = join(root, scriptPath);
  if (existsSync(absolute) && (lstatSync(absolute).mode & 0o111) === 0) {
    failures.push(`${scriptPath}: example script must be executable`);
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Documentation validation failed:\n${failures.map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Documentation validation passed: ${markdownFiles.length} Markdown files and ${featureCount} feature scenarios.\n`,
);
