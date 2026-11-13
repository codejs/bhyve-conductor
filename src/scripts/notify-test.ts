/** Sends a test message to the configured Telegram chat. Usage: npm run notify:test */
import { loadConfig } from '../config.ts';
import { TelegramClient, TelegramPermanentError } from '../notify/telegram.ts';

const env = loadConfig(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
  console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env (see .env.example).');
  process.exit(1);
}
const telegram = new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID });
try {
  await telegram.send('✅ <b>Lawn conductor</b> can send notifications to this chat.');
  console.log(`Sent a test message to chat ${env.TELEGRAM_CHAT_ID}.`);
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  if (err instanceof TelegramPermanentError) {
    console.error(
      'Check that: the token is right (401); the chat id is right and the bot has been added to the group/channel, ' +
        'or you have sent /start to the bot in a private chat (400 "chat not found" / 403).',
    );
  }
  process.exit(1);
}
