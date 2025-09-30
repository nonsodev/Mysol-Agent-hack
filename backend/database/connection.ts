import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient, Client, InValue } from '@libsql/client';

export class DatabaseManager {
  private client: Client;
  private initialized = false;

  constructor() {
    const url = process.env.LIBSQL_URL || 'file:./mastra.db';
    const authToken = process.env.LIBSQL_AUTH_TOKEN;
    this.client = createClient(
      authToken ? { url, authToken } : { url }
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Resolve __dirname in ESM
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const schemaPath = path.join(__dirname, 'schema.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');

      // Robustly split schema into executable statements without
      // breaking CREATE TRIGGER ... BEGIN ... END; blocks
      const statements: string[] = [];
      const lines = schema.split('\n');
      let buffer = '';
      let inTrigger = false;

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        buffer += line + '\n';

        // Detect start of a trigger
        if (!inTrigger && /CREATE\s+TRIGGER/i.test(line)) {
          inTrigger = true;
        }

        if (inTrigger) {
          // End of trigger statement ends with END; (may have spaces before semicolon)
          if (/\bEND\b\s*;\s*$/i.test(line)) {
            statements.push(buffer.trim());
            buffer = '';
            inTrigger = false;
          }
          continue;
        }

        // Non-trigger statements: push when a line ends with semicolon
        if (/;\s*$/.test(line)) {
          const stmt = buffer.trim().replace(/;\s*$/,'');
          if (stmt.length > 0) statements.push(stmt);
          buffer = '';
        }
      }

      const tail = buffer.trim();
      if (tail.length > 0) statements.push(tail);

      for (const stmt of statements) {
        await this.client.execute(stmt);
      }

      console.log('Database schema initialized successfully (LibSQL)');
      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize database schema:', error);
      throw error;
    }
  }

  async run(sql: string, params: InValue[] = []): Promise<void> {
    await this.client.execute({ sql, args: params });
  }

  async get<T = any>(sql: string, params: InValue[] = []): Promise<T | undefined> {
    const res = await this.client.execute({ sql, args: params });
    const row = res.rows?.[0] as unknown as T | undefined;
    return row;
  }

  async all<T = any>(sql: string, params: InValue[] = []): Promise<T[]> {
    const res = await this.client.execute({ sql, args: params });
    return (res.rows as unknown as T[]) || [];
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    await this.run('BEGIN');
    try {
      const result = await callback();
      await this.run('COMMIT');
      return result;
    } catch (error) {
      await this.run('ROLLBACK');
      throw error;
    }
  }
}

export const db = new DatabaseManager();
