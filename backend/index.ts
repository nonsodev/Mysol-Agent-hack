import dotenv from 'dotenv';
import { db } from './database/connection';
import { TelegramBotRunner } from './bot/bot';

async function bootstrap() {
  dotenv.config();

  // Initialize database schema (LibSQL)
  await db.initialize();

  // Start Telegram bot
  new TelegramBotRunner();
  console.log('Backend initialized. Telegram bot is running.');
}

bootstrap().catch((err) => {
  console.error('Backend bootstrap failed:', err);
  process.exit(1);
});
