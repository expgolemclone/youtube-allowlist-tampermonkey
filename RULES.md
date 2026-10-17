# Rules

## Releases

- Userscript changes are not complete until a stable GitHub Release is published from the tested, pushed commit on `main`.
- Bump the userscript `@version` for each userscript release. Keep `package.json`, `package-lock.json`, and the `v<version>` release tag aligned.
- Attach the standalone `youtube-allowlist.user.js` from synchronized source as a release asset. Verify the public download matches the source byte for byte and provide its installation link.
- Keep this repository public. Do not claim iPhone Safari support without testing a real device with its userscript manager.
