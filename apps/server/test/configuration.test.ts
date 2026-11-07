import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigurationService } from "../src/config/configuration.service.js";
import {
  parseProperties,
  serializeProperties,
} from "../src/config/properties.js";

test("removing object storage preserves authentication, branding and local paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenda-link-config-"));
  const previous = process.env.AGENDA_LINK_WORKSPACE;
  process.env.AGENDA_LINK_WORKSPACE = root;
  try {
    const config = new ConfigurationService();
    const original = parseProperties(await readFile(config.filePath, "utf8"));
    const saved = {
      ...original,
      "storage.data-dir": "./persistent-data",
      "platform.name": "企业协作中心",
      "feishu.login.app-id": "login-app",
      "feishu.login.app-secret": "test-login-secret",
      "recording.storage": "oss",
      "oss.access-key-secret": "retired-test-secret",
      "cos.secret-key": "retired-test-secret",
    };
    await writeFile(config.filePath, serializeProperties(saved));
    await config.load();
    const persisted = parseProperties(await readFile(config.filePath, "utf8"));
    for (const key of [
      "auth.jwt-secret",
      "storage.data-dir",
      "platform.name",
      "feishu.login.app-id",
      "feishu.login.app-secret",
    ]) {
      assert.equal(persisted[key], saved[key as keyof typeof saved]);
      assert.equal(config.get(key), saved[key as keyof typeof saved]);
    }
    for (const key of [
      "recording.storage",
      "oss.access-key-secret",
      "cos.secret-key",
    ]) {
      assert.equal(persisted[key], undefined);
      assert.equal(config.settings()[key], undefined);
    }
    assert.equal(config.settings()["feishu.login.app-secret"], "********");
    await config.update({
      "recording.storage": "cos",
      "cos.secret-key": "ignored",
    });
    assert.equal(config.get("recording.storage"), "");
    assert.equal(
      config.databasePath,
      path.join(root, "persistent-data/agenda-link.sqlite"),
    );
  } finally {
    if (previous === undefined) delete process.env.AGENDA_LINK_WORKSPACE;
    else process.env.AGENDA_LINK_WORKSPACE = previous;
    await rm(root, { recursive: true, force: true });
  }
});
