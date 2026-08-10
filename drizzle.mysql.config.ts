import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema.mysql.generated.ts",
  out: "./drizzle-mysql",
  dialect: "mysql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "mysql://placeholder:placeholder@127.0.0.1:3306/topology_scm",
  },
  strict: true,
  verbose: true,
});
