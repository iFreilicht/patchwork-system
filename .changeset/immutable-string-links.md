---
"@inkandswitch/patchwork-filesystem": patch
---

`resolvePath` follows a link stored as an `ImmutableString` as well as one stored as a plain string, in a directory doc's entries, a folder doc's `docs[].url`, and wherever a path ends on a link. An `ImmutableString` reads back as an object, so these were taken for something that isn't a link: the path stopped there, or the URL itself was served as the file's contents. pushwork writes package links as `ImmutableString`s, which are one op where a plain string is an op per character, rewritten on every push.
