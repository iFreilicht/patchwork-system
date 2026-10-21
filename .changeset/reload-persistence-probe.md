---
"@inkandswitch/patchwork-e2e": patch
---

The reload-persistence test now checks that the service worker has the new doc, by reading it from a second tab, before it reloads. It used to poll the creating tab, whose own Repo answers from memory, so the reload could cut the relay mid-sync and the `find()` after it would hang until the test timed out. This happened most often in WebKit.
