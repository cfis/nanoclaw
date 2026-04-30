---
name: add-imessage-spectrum
description: Add iMessage channel via Photon Spectrum (cloud). For users who got project_id + secret_key from app.photon.codes. Linux-friendly — no Mac required.
---

# Add iMessage Channel (Spectrum)

Adds iMessage support backed by Photon's newer Spectrum SDK. Authenticates with `project_id` + `project_secret` from [app.photon.codes](https://app.photon.codes); the iMessage gateway runs in Photon's cloud, so the host can be on Linux.

This is **separate** from `/add-imessage`, which uses the older `chat-adapter-imessage` package and requires either a Mac (local mode) or legacy enterprise credentials (`IMESSAGE_SERVER_URL` + `IMESSAGE_API_KEY`). Use this skill if your dashboard at app.photon.codes only shows project_id and secret_key.

## Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/imessage-spectrum.ts` exists
- `src/channels/index.ts` contains `import './imessage-spectrum.js';`
- `spectrum-ts` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

## 1. Install spectrum-ts

```bash
pnpm install spectrum-ts@1.1.1
```

The version is pinned to satisfy this project's `minimumReleaseAge: 4320` (3 days). Bumping it requires a version that has been on npm for at least 3 days. Do not add `spectrum-ts` to `minimumReleaseAgeExclude` without human approval.

## 2. Add the adapter

The adapter file is `src/channels/imessage-spectrum.ts`. If it's missing, create it (this skill does not currently fetch from a `channels` branch — the file lives directly in trunk).

## 3. Wire self-registration

Append to `src/channels/index.ts` (skip if already present):

```typescript
import './imessage-spectrum.js';
```

## 4. Build

```bash
pnpm run build
```

## Credentials

1. Sign in at [app.photon.codes](https://app.photon.codes).
2. Open your project; copy the **project ID** and **secret key**.
3. Add to `.env`:

```bash
IMESSAGE_SPECTRUM_PROJECT_ID=<your project id>
IMESSAGE_SPECTRUM_PROJECT_SECRET=<your secret key>
```

4. Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Restart

Restart the host so the new adapter registers:

- macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- Linux: `systemctl --user restart nanoclaw`

Confirm in `logs/nanoclaw.log`:

```
Channel adapter started { channel: 'imessage-spectrum', type: 'imessage-spectrum' }
```

## Next Steps

If you're in `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `imessage-spectrum`
- **terminology**: iMessage has "conversations." Each conversation is with a contact identified by phone number or email address. Group chats are also supported.
- **how-to-find-id**: The platform ID is the contact's phone number (e.g. `+15551234567`) or email address. For group chats, the ID is assigned by Spectrum internally — discover it by sending the bot a message in the group and checking inbound logs / `data/v2-sessions/<agent-group>/<session>/inbound.db`.
- **supports-threads**: no
- **typical-use**: Interactive 1:1 chat — personal messaging
- **default-isolation**: Same agent group if you're the only person messaging the bot across iMessage and other channels. Separate agent group if different contacts should have information isolation.

## v1 Limitations

- **Text only.** Inbound non-text messages (attachments, voice, contact cards, polls, reactions) are silently dropped. Outbound is text-only.
- **No tapback reactions.** Spectrum exposes them but the adapter doesn't translate yet.
- **Cold-DM to a group.** `openDM(handle)` resolves a single user → DM space. Pre-existing groups are reachable only after at least one inbound message in that group has been seen (the space is cached at that point).
- **Early-preview SDK.** Spectrum docs say "APIs may change between releases." Pinned to `1.1.1` (the build was verified against this version). Bumping requires re-validation.

## Troubleshooting

- **Adapter doesn't start (no log line).** Check `IMESSAGE_SPECTRUM_PROJECT_ID` and `IMESSAGE_SPECTRUM_PROJECT_SECRET` are both set in `.env`. The factory returns `null` (and the registry skips the adapter) if either is missing.
- **`SpectrumCloudError` at startup.** Usually means the project ID / secret pair is wrong, or the project's iMessage subscription isn't active. Verify at [app.photon.codes](https://app.photon.codes).
- **Outbound delivery silently fails.** Check `logs/nanoclaw.error.log` for `"cannot resolve space for delivery"`. The adapter only auto-resolves spaces from prior inbound messages or by treating the platform_id as a phone/email DM handle. Group spaces with no prior inbound message can't be reached.
