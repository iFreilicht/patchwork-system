import { expect, test, type Page } from "@playwright/test";
import { online, openTab } from "./bench.js";

// The automerge worker signs as the same subduction peer as the tabs, and the
// server keeps ephemeral subscriptions per peer. A tab must keep receiving a
// document's ephemeral messages (presence: cursors, selections) after the
// worker has resolved an automerge: URL and evicted what it loaded.

/** How many of Alice's messages the tab receives in `ms`. */
async function receivedDuring(page: Page, ms: number): Promise<number> {
  const before = await page.evaluate(() => window.received);
  await page.waitForTimeout(ms);
  return (await page.evaluate(() => window.received)) - before;
}

declare global {
  interface Window {
    received: number;
    quiet: boolean;
  }
}

test("patchwork: a tab keeps receiving ephemeral messages after the automerge worker resolves a URL", async ({
  browser,
}) => {
  // Two profiles: Alice publishes, Bob listens.
  const alice = await openTab(await browser.newContext(), "patchwork");
  const bob = await openTab(await browser.newContext(), "patchwork");
  await Promise.all([online(alice), online(bob)]);

  const url = await alice.evaluate(async () => {
    const handle = window.repo.create<{ title: string }>({ title: "presence" });
    await window.repo.flush();
    window.quiet = false;
    setInterval(() => window.quiet || handle.broadcast({ from: "alice" }), 100);
    return handle.url;
  });
  await bob.evaluate(async (url) => {
    const { handle } = await window.bench.find(url);
    window.received = 0;
    handle.on("ephemeral-message", ({ message }) => {
      if ((message as { from?: string }).from === "alice") window.received++;
    });
  }, url);
  await bob.waitForTimeout(2_000);
  expect(await receivedDuring(bob, 3_000)).toBeGreaterThan(0);

  // What loading a tool's module does: the service worker hands an automerge:
  // URL to the automerge worker, which connects to the sync server. Here, a
  // document Bob doesn't have yet, so the worker fetches it. While it is
  // connected, Alice's messages reach it too.
  const elsewhere = await alice.evaluate(async () => {
    const handle = window.repo.create<{ title: string }>({ title: "elsewhere" });
    await window.repo.flush();
    return handle.url;
  });
  await bob.evaluate(async (url) => {
    await fetch(`/${encodeURIComponent(url)}/`).catch(() => undefined);
  }, elsewhere);

  // The worker evicts what it loaded 5 s after its last handoff. Alice is
  // quiet meanwhile, like a collaborator who isn't moving: a message of hers
  // arriving during the eviction makes the worker load the document again,
  // which hides the bug.
  await alice.evaluate(() => (window.quiet = true));
  await bob.waitForTimeout(8_000);
  await alice.evaluate(() => (window.quiet = false));
  await bob.waitForTimeout(1_000);
  expect(await receivedDuring(bob, 3_000)).toBeGreaterThan(0);
});
