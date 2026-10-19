---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

Tabs hear ephemeral messages (presence, cursors) from other peers again. The sync node looked up which Repos to forward an inbound ephemeral message to by `id.toString()`, but Subduction's `onEphemeral` passes a `Topic`, and `Topic.toString()` returns an abbreviated hex code (`3449915b…`) rather than as the full sedimentree id the Repos subscribed under. No Repo ever matched, so only messages from other tabs on the same origin, which the node forwards itself, got through.
