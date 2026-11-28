// Release readiness: package.json carries a stable version, CHANGELOG.md has a
// dated `## [X.Y.Z] - YYYY-MM-DD` section for it, and no heading is left as
// Unreleased. publish.yml's "Verify release tag" step checks the tag itself.
import { readFileSync } from "node:fs";
import process from "node:process";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const changelog = readFileSync("CHANGELOG.md", "utf8");
const headings = changelog.split("\n").filter((line) => line.startsWith("## "));

const errors = [];
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  errors.push(`package.json version ${String(version)} is not a stable X.Y.Z`);
} else if (
  !headings.some((line) =>
    new RegExp(
      `^## \\[${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`,
    ).test(line),
  )
) {
  errors.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" heading`);
}
for (const line of headings.filter((heading) => /unreleased/i.test(heading))) {
  errors.push(`CHANGELOG.md heading still says Unreleased: ${line}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL ${error}`);
  process.exit(1);
}
console.log(`OK    release: ${version} matches a dated CHANGELOG.md section`);
