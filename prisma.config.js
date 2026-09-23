// prisma.config.js
//
// Plain JS, not .ts: the production Docker image has no TypeScript (it's a
// devDependency, correctly not shipped) — the prisma CLI can only transpile a
// .ts config file when `typescript` is resolvable, which silently falls back
// to "no config loaded" otherwise (symptom: "datasource.url property is
// required" even though DATABASE_URL is set). A .js config needs no
// transpiler, so `prisma migrate deploy` works the same in every stage.
require('dotenv/config');
const { defineConfig } = require('prisma/config');

module.exports = defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
