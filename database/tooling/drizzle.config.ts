import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./database/migrations/d1",
  schema: "./database/runtime/schema.ts",
  dialect: "sqlite",
});
