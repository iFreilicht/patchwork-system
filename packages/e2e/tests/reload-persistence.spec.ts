import { expect, test } from "@playwright/test";
import {
  createDoc,
  findDocField,
  waitForRepoReady,
  waitForServiceWorkerActive,
} from "./helpers.js";

/**
 * IndexedDB persistence across reloads.
 *
 * A doc created in a tab is synced to the SW, which persists it to
 * IndexedDB (Subduction storage). After a reload — even though the tab's
 * in-memory Repo is gone — the doc must still be retrievable, proving the
 * persistence layer works without any network.
 */
test("a doc survives a page reload via IndexedDB", async ({
  context,
  page,
}) => {
  await page.goto("/");
  await waitForServiceWorkerActive(page);
  await waitForRepoReady(page);

  const url = await createDoc(page, { note: "persist-me" });

  // Confirm the SW has the doc before reloading. Asking `page` proves
  // nothing (its own Repo answers from memory), so ask a tab that never
  // had it: otherwise the reload can tear down the relay mid-sync and the
  // doc is lost before it reaches the SW.
  const probe = await context.newPage();
  await probe.goto("/");
  await waitForRepoReady(probe);
  await expect
    .poll(async () => findDocField<string>(probe, url, "note"), {
      timeout: 15_000,
    })
    .toBe("persist-me");
  await probe.close();

  await page.reload();
  await waitForRepoReady(page);

  const value = await findDocField<string>(page, url, "note");
  expect(value).toBe("persist-me");
});
