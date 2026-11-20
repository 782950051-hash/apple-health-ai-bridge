# Receiver and Workers

This directory contains the extracted Node receiver and health/weather processing modules. Runtime state is outside the repository, under `~/Library/Application Support/AppleHealthUpload` by default.

Requirements: Node.js 20+, Python 3, Hermes CLI available on `PATH`, and a configured iCloud Drive input folder. The Python reader supports stable file reads and weather schema normalization; the Node receiver owns import ledgers, health analysis state, separate health/weather outboxes, and delivery safety.

Run isolated tests:

```sh
npm test
```

The sender adapter currently depends on private Hermes Weixin account/context files in the local user's Hermes state. It has no access to author credentials, but is not a documented stable Hermes SDK. Keep `HEALTH_D3_MODE=prepare` until the local sender configuration has been reviewed and verified.
