/**
 * Standalone smoke test for spectrum-ts iMessage integration.
 * Run: pnpm exec tsx scripts/test-spectrum.ts
 *
 * Validates (in order):
 *  1. .env has IMESSAGE_SPECTRUM_PROJECT_ID + IMESSAGE_SPECTRUM_PROJECT_SECRET
 *  2. Photon cloud responds for this project (subscription tier, iMessage info)
 *  3. iMessage platform is toggled on for the project
 *  4. Spectrum() init succeeds with the provided creds (auth handshake)
 *  5. The message stream opens; pump for 30s and dump any inbound messages
 *
 * Does not touch nanoclaw's running service or DBs.
 */
import { Spectrum, cloud } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers/imessage';

import { readEnvFile } from '../src/env.js';

async function main(): Promise<void> {
  const env = readEnvFile(['IMESSAGE_SPECTRUM_PROJECT_ID', 'IMESSAGE_SPECTRUM_PROJECT_SECRET']);
  const projectId = env.IMESSAGE_SPECTRUM_PROJECT_ID;
  const projectSecret = env.IMESSAGE_SPECTRUM_PROJECT_SECRET;

  if (!projectId || !projectSecret) {
    console.error('Missing IMESSAGE_SPECTRUM_PROJECT_ID or IMESSAGE_SPECTRUM_PROJECT_SECRET in .env');
    process.exit(1);
  }
  console.log('[1] env vars present. project_id =', projectId);

  console.log('[2] issuing iMessage tokens (validates secret_key)...');
  try {
    const tokens = await cloud.issueImessageTokens(projectId, projectSecret);
    const masked = {
      type: tokens.type,
      expiresIn: tokens.expiresIn,
      ...(tokens.type === 'dedicated'
        ? { authKeys: Object.keys(tokens.auth) }
        : { tokenLen: (tokens as { token: string }).token.length }),
    };
    console.log('    tokens:', masked);
  } catch (err) {
    console.error('    FAILED:', err);
    process.exit(2);
  }

  console.log('[3] querying cloud.getImessageInfo (tier hint)...');
  try {
    const info = await cloud.getImessageInfo(projectId);
    console.log('    imessage info:', info);
  } catch (err) {
    console.error('    skipped (probably needs Spectrum context):', err instanceof Error ? err.message : err);
  }

  console.log('[6] booting Spectrum() with iMessage provider...');
  let app: Awaited<ReturnType<typeof Spectrum>>;
  try {
    app = await Spectrum({
      projectId,
      projectSecret,
      providers: [imessage.config()],
    });
    console.log('    Spectrum app booted');
  } catch (err) {
    console.error('    FAILED:', err);
    process.exit(6);
  }

  const TEST_HANDLE = '+13036680356';
  console.log(`[6.5] resolving user + space for ${TEST_HANDLE} and sending a test message...`);
  try {
    const im = imessage(app);
    const user = await im.user(TEST_HANDLE);
    console.log('    user resolved:', { id: user.id, platform: user.__platform });
    const space = await im.space([user]);
    console.log('    space resolved:', { id: space.id, platform: space.__platform });
    const sent = await space.send('NanoClaw spectrum smoke test — please reply');
    console.log('    sent:', sent && !Array.isArray(sent) ? { id: sent.id } : sent);
  } catch (err) {
    console.error('    OUTBOUND FAILED:', err);
  }

  console.log('[7] pumping app.messages for 60s — reply from your iPhone now');
  const deadline = Date.now() + 60_000;
  let received = 0;

  const pump = (async () => {
    for await (const [space, message] of app.messages) {
      received += 1;
      const im = imessage(space);
      console.log('    [inbound]', {
        spaceId: space.id,
        spaceType: im.type,
        senderId: message.sender.id,
        platform: message.platform,
        contentType: message.content.type,
        text:
          message.content.type === 'text'
            ? message.content.text.slice(0, 200)
            : `<${message.content.type}>`,
        timestamp: message.timestamp.toISOString(),
      });
      if (Date.now() > deadline) break;
    }
  })();

  await Promise.race([pump, new Promise((r) => setTimeout(r, 60_000))]);

  console.log(`[8] received ${received} message(s) during pump window`);
  console.log('[9] stopping Spectrum...');
  await app.stop();
  console.log('done');
}

main().catch((err) => {
  console.error('unexpected error:', err);
  process.exit(99);
});
