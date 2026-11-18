import * as fs from "fs/promises";

function modeOf(stat) {
  return (stat.mode & 0o7777).toString(8).padStart(4, "0");
}

function typeOf(stat) {
  if (stat.isDirectory()) return "directory";
  if (stat.isBlockDevice()) return "block-device";
  if (stat.isCharacterDevice()) return "character-device";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  return "other";
}

export async function worktreeFingerprintMaterial({ root, files, hashFiles, io = fs }) {
  if (typeof root !== "string" || !root.startsWith("/")) {
    throw new Error("Snapshot repository root must be an absolute path");
  }
  const entries = [];
  const regularPaths = [];

  for (const file of files) {
    if (file.status === "D") {
      entries.push(`deleted\0${file.path}`);
      continue;
    }

    const absolute = `${root}/${file.path}`;
    let stat;
    try {
      stat = await io.lstat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Changed path disappeared while fingerprinting: ${file.path}`);
      }
      throw error;
    }

    if (stat.isSymbolicLink()) {
      const target = await io.readlink(absolute);
      entries.push(`symlink\0${file.path}\0${modeOf(stat)}\0${target}`);
    } else if (stat.isFile()) {
      entries.push({ path: file.path, mode: modeOf(stat) });
      regularPaths.push(file.path);
    } else {
      entries.push(`${typeOf(stat)}\0${file.path}\0${modeOf(stat)}\0${stat.size}`);
    }
  }

  let hashes = [];
  if (regularPaths.length) {
    hashes = String(await hashFiles(regularPaths)).trimEnd().split("\n");
    if (hashes.length !== regularPaths.length || hashes.some((hash) => !hash)) {
      throw new Error("Git returned an incomplete changed-file fingerprint");
    }
  }

  let hashIndex = 0;
  return entries.map((entry) => {
    if (typeof entry === "string") return entry;
    const hash = hashes[hashIndex++];
    return `blob\0${entry.path}\0${entry.mode}\0${hash}`;
  }).join("\0");
}
