# estoc-dev/suite

Estoc rebuilt from the offline-first end. An identity is generated on the
device, data lives on the device, and documents are signed and verified
there with no network. Reaching other people is a layer added on top:
DIDComm is one transport that can attach later, not the shape of the core.

One pnpm workspace; packages go under `packages/` as they are written.

```bash
pnpm install
pnpm typecheck && pnpm test
```
