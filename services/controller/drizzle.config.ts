import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  schemaFilter: ['controller'],
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
