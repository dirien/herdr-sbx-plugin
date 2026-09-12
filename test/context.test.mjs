import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { canonicalPath, gitToplevel, isInside, resolveMountRoot, resolveWorkdir } from "../src/context.mjs";
import { git } from "./helpers.mjs";

test("isInside treats the root itself and descendants as inside", () => {
  assert.equal(isInside("/repo", "/repo"), true);
  assert.equal(isInside("/repo", "/repo/src/x"), true);
  assert.equal(isInside("/repo", "/repo-other"), false);
  assert.equal(isInside("/repo", "/repo/..cache"), true, "a directory name starting with dots is not a traversal");
  assert.equal(isInside("/repo", "/repo/../elsewhere"), false);
  assert.equal(isInside("/repo", "/"), false);
  assert.equal(isInside("/repo/src", "/repo"), false);
});

const noRepo = () => null;

test("resolveMountRoot prefers the worktree checkout, then the workspace, then the pane", () => {
  assert.equal(resolveMountRoot({ worktree: { checkout_path: "/wt" }, workspace_cwd: "/ws", focused_pane_cwd: "/ws/src" }, { toplevel: noRepo }), "/wt");
  assert.equal(resolveMountRoot({ workspace_cwd: "/ws", focused_pane_cwd: "/elsewhere" }, { toplevel: noRepo }), "/ws");
  assert.equal(resolveMountRoot({ focused_pane_cwd: "/repo/src" }, { toplevel: () => "/repo" }), "/repo");
  assert.equal(resolveMountRoot({ focused_pane_cwd: "/scratch" }, { toplevel: noRepo }), "/scratch");
  assert.equal(resolveMountRoot({ worktree: { checkout_path: "" }, workspace_cwd: "" }, { toplevel: noRepo }), null);
  assert.equal(resolveMountRoot({}, { toplevel: noRepo }), null);
});

test("resolveWorkdir keeps the pane directory only when it lies inside the root", () => {
  assert.equal(resolveWorkdir({ focused_pane_cwd: "/ws/src" }, "/ws"), "/ws/src");
  assert.equal(resolveWorkdir({ focused_pane_cwd: "/other" }, "/ws"), "/ws");
  assert.equal(resolveWorkdir({}, "/ws"), "/ws");
});

test("mount root and workdir are canonical even when the context uses a symlinked spelling", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "herdr-sbx-ctx-")));
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, ["init", "-q"]);
  const link = path.join(root, "alias");
  symlinkSync(repo, link);
  const viaLink = resolveMountRoot({ focused_pane_cwd: path.join(link, "src") });
  assert.equal(viaLink, repo);
  assert.equal(resolveWorkdir({ focused_pane_cwd: path.join(link, "src") }, viaLink), path.join(repo, "src"));
  assert.equal(resolveMountRoot({ workspace_cwd: link, focused_pane_cwd: path.join(repo, "src") }, { toplevel: noRepo }), repo);
  assert.equal(isInside(link, path.join(repo, "src")), true);
});

test("gitToplevel finds the repository root and returns null elsewhere", () => {
  const root = mkdtempSync(path.join(tmpdir(), "herdr-sbx-ctx-"));
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, ["init", "-q"]);
  assert.equal(gitToplevel(path.join(repo, "src")), path.join(repo, "src") === repo ? repo : gitToplevel(repo));
  assert.ok(gitToplevel(repo).endsWith("repo"));
  assert.equal(gitToplevel("/"), null);
});

test("canonicalPath resolves a symlinked prefix even when the path itself is gone", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "herdr-sbx-canon-")));
  mkdirSync(path.join(dir, "real"));
  symlinkSync(path.join(dir, "real"), path.join(dir, "alias"));
  assert.equal(canonicalPath(path.join(dir, "alias")), path.join(dir, "real"));
  assert.equal(canonicalPath(path.join(dir, "alias", "gone", "deeper")), path.join(dir, "real", "gone", "deeper"), "the longest existing ancestor is canonicalised");
  assert.equal(canonicalPath(path.join(dir, "alias", "..", "alias", "gone")), path.join(dir, "real", "gone"));
  assert.equal(canonicalPath("/definitely/not/here"), "/definitely/not/here");
});
