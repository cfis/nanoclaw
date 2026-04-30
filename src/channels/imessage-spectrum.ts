/**
 * iMessage channel adapter via Spectrum (spectrum-ts).
 *
 * Photon's newer SDK — replaces the chat-adapter-imessage path that
 * required a legacy server URL + API key. Authenticates with project_id +
 * project_secret from app.photon.codes; iMessage gateway runs in Photon
 * cloud, so the host can be on Linux. v1 supports text DMs and groups
 * (inbound + outbound). Attachments and reactions are punted.
 *
 * Self-registers on import.
 */
import type { Space } from 'spectrum-ts';
import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers/imessage';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

type SpectrumApp = Awaited<ReturnType<typeof Spectrum>>;

registerChannelAdapter('imessage-spectrum', {
  factory: () => {
    const env = readEnvFile(['IMESSAGE_SPECTRUM_PROJECT_ID', 'IMESSAGE_SPECTRUM_PROJECT_SECRET']);
    const projectId = env.IMESSAGE_SPECTRUM_PROJECT_ID;
    const projectSecret = env.IMESSAGE_SPECTRUM_PROJECT_SECRET;
    if (!projectId || !projectSecret) return null;

    let app: SpectrumApp | null = null;
    let pumpDone: Promise<void> | null = null;
    // Cache spaces from inbound messages so deliver() can send back to the
    // same conversation. For cold DMs (openDM) we also seed the cache after
    // resolving the space via imessage(app).space(user).
    const spaceCache = new Map<string, Space>();

    const adapter: ChannelAdapter = {
      name: 'imessage-spectrum',
      channelType: 'imessage-spectrum',
      supportsThreads: false,

      async setup(config: ChannelSetup): Promise<void> {
        app = await Spectrum({
          projectId,
          projectSecret,
          providers: [imessage.config()],
        });

        pumpDone = (async () => {
          for await (const [space, message] of app!.messages) {
            try {
              if (message.platform !== 'iMessage') continue;
              if (message.content.type !== 'text') continue; // v1: text only
              spaceCache.set(space.id, space);

              // Narrow the space to access iMessage-specific `type: "dm" | "group"`.
              const imSpace = imessage(space);
              const isGroup = imSpace.type === 'group';

              await config.onInbound(space.id, null, {
                id: message.id,
                kind: 'chat',
                timestamp: message.timestamp.toISOString(),
                isMention: !isGroup, // every DM is implicitly for the bot; groups fall through to text-match
                isGroup,
                content: {
                  text: message.content.text,
                  sender: message.sender.id,
                  senderId: `imessage-spectrum:${message.sender.id}`,
                },
              });
            } catch (err) {
              log.error('imessage-spectrum: inbound pump threw', { err });
            }
          }
        })();
      },

      async teardown(): Promise<void> {
        if (app) {
          try {
            await app.stop();
          } catch (err) {
            log.warn('imessage-spectrum: app.stop threw', { err });
          }
        }
        if (pumpDone) {
          try {
            await pumpDone;
          } catch {
            // pump errors are already logged inside the loop
          }
        }
        app = null;
        pumpDone = null;
        spaceCache.clear();
      },

      isConnected(): boolean {
        return app !== null;
      },

      async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
        const text = extractText(message);
        if (text === null || !app) return undefined;

        const space = await resolveSpace(app, platformId, spaceCache);
        if (!space) {
          log.warn('imessage-spectrum: cannot resolve space for delivery', { platformId });
          return undefined;
        }

        const sent = await space.send(text);
        return sent && !Array.isArray(sent) ? sent.id : undefined;
      },

      async openDM(handle: string): Promise<string> {
        if (!app) throw new Error('imessage-spectrum: app not initialized');
        const im = imessage(app);
        const user = await im.user(handle);
        const space = await im.space([user]);
        spaceCache.set(space.id, space);
        return space.id;
      },
    };

    return adapter;
  },
});

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

async function resolveSpace(app: SpectrumApp, platformId: string, cache: Map<string, Space>): Promise<Space | null> {
  const cached = cache.get(platformId);
  if (cached) return cached;
  // Fallback: assume platformId is a DM handle (phone/email). For group ids,
  // there's no public way to reconstruct the space without a member list, so
  // an unknown group id will return null.
  try {
    const im = imessage(app);
    const user = await im.user(platformId);
    const space = await im.space([user]);
    cache.set(space.id, space);
    return space;
  } catch (err) {
    log.warn('imessage-spectrum: failed to reconstruct space', { platformId, err });
    return null;
  }
}
