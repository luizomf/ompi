import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it.each([
  ["scheduler", "linked"], ["subagents", "linked"],
  ["scheduler", "copied"], ["subagents", "copied"],
])("loads %s from a %s resource directory", async (name, layout) => {
  const root = await mkdtemp(join(tmpdir(), "ompi-linked-extension-"));
  const linked = join(root, name);
  try {
    if (layout === "linked") await symlink(resolve("extensions", name), linked, "dir");
    else {
      // Sannux refresh uses rsync -aL: each extension is copied with its internal
      // links dereferenced, without the repository's sibling shared directory.
      await cp(resolve("extensions", name), linked, { recursive: true, dereference: true });
    }
    // A fresh process avoids loader caches masking lexical symlink imports.
    // Factory loading only: no sessions, provider requests, or Queue work.
    const script = `
      import { loadExtensions } from ${JSON.stringify(resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"))};
      const result = await loadExtensions([process.argv[1]], process.cwd());
      console.log(JSON.stringify({ errors: result.errors, count: result.extensions.length }));
    `;
    const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", script, join(linked, "index.ts")]);
    expect(JSON.parse(stdout)).toEqual({ errors: [], count: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
