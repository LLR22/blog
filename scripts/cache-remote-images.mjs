import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = path.join(root, "content");
const remoteDir = path.join(contentDir, "assets", "remote");
const execFileAsync = promisify(execFile);

const hash = (value) => crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);

function remoteImageName(src) {
  const url = new URL(src);
  const ext = path.extname(url.pathname).slice(0, 12) || ".img";
  return `${hash(src)}${ext}`;
}

async function findMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "assets") continue;
      files.push(...(await findMarkdownFiles(fullPath)));
    } else if (entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

function imageUrls(markdown) {
  const urls = new Set();
  const imagePattern = /!\[[^\]]*]\((https?:\/\/[^)]+)\)/g;
  let match;

  while ((match = imagePattern.exec(markdown))) {
    urls.add(match[1].trim());
  }

  return [...urls];
}

async function download(url, dest) {
  await execFileAsync("curl", [
    "--location",
    "--fail",
    "--silent",
    "--show-error",
    "--user-agent",
    "personal-blog-image-cache/1.0",
    "--output",
    dest,
    url
  ]);
}

async function main() {
  await fs.mkdir(remoteDir, { recursive: true });

  const files = await findMarkdownFiles(contentDir);
  const urls = new Set();
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    for (const url of imageUrls(source)) urls.add(url);
  }

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const url of urls) {
    const name = remoteImageName(url);
    const dest = path.join(remoteDir, name);

    try {
      await fs.access(dest);
      skipped += 1;
      continue;
    } catch {
      // Download missing image below.
    }

    try {
      await download(url, dest);
      downloaded += 1;
      console.log(`downloaded ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`failed ${url}: ${error.message}`);
    }
  }

  console.log(`Remote image cache: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
