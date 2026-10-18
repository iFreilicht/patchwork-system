---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-bootloader": patch
---

The automerge protocol handler worker no longer cuts tabs off from ephemeral messages (presence: cursors, selections). It signs as the same Subduction peer as the tabs, and the server keeps ephemeral subscriptions per peer, so it received the tabs' presence, set up their documents from it, and unsubscribed the tabs from them when it evicted its documents 5 s after its last handoff. The tabs kept sending presence, but stopped receiving it.

The automerge-repo patch adds a `subductionEphemeral` option to `Repo` (default `true`). With `false`, the Repo doesn't subscribe to its documents' topics, doesn't unsubscribe them on detach, and drops inbound ephemeral messages. The worker sets it for both its plain and its keyhive repo.
