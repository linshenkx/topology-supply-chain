import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("formal trial shell does not expose static business results or inert actions", async () => {
  const page = await readFile("apps/web/app/page.tsx", "utf8");

  assert.match(page, /工作台尚未配置/u);
  assert.match(page, /工厂协同尚未配置/u);
  for (const removedDemoContent of [
    "AI助手",
    "EX-260728-01",
    "SL-CM-09 的专属合格率标准已保存",
    "订单正在有序推进",
    "已打开外部协同账号管理",
  ]) {
    assert.doesNotMatch(page, new RegExp(removedDemoContent, "u"));
  }
});
