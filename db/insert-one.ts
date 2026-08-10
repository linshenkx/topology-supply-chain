type ReturningBuilder<T> = {
  returning?: () => PromiseLike<T[]>;
  $returningId?: () => PromiseLike<Array<Record<string, number>>>;
};

/**
 * SQLite/D1 supports INSERT ... RETURNING, while RDS MySQL uses Drizzle's
 * $returningId() emulation. Keeping this distinction here prevents business
 * routes from depending on a database-specific insert syntax.
 */
export async function insertOne<T>(
  builder: ReturningBuilder<T>,
  loadById: (id: number) => Promise<T[]>,
  idField = "id",
) {
  if (typeof builder.returning === "function") {
    const [record] = await builder.returning();
    if (!record) throw new Error("新增记录后未能读取结果。");
    return record;
  }
  if (typeof builder.$returningId === "function") {
    const [inserted] = await builder.$returningId();
    const id = Number(inserted?.[idField]);
    if (!id) throw new Error("数据库未返回新增记录ID。");
    const [record] = await loadById(id);
    if (!record) throw new Error("新增记录后未能按ID读取结果。");
    return record;
  }
  throw new Error("当前数据库驱动不支持返回新增记录。");
}

type MutationBuilder = {
  run?: () => PromiseLike<{ changes?: number; rowsAffected?: number }>;
  execute?: () => PromiseLike<unknown>;
};

export async function executeAffected(builder: MutationBuilder) {
  if (typeof builder.run === "function") {
    const result = await builder.run();
    return Number(result.changes ?? result.rowsAffected ?? 0);
  }
  if (typeof builder.execute === "function") {
    const result = await builder.execute();
    const header = Array.isArray(result) ? result[0] : result;
    if (header && typeof header === "object") {
      const value = header as { affectedRows?: number; rowsAffected?: number };
      return Number(value.affectedRows ?? value.rowsAffected ?? 0);
    }
  }
  throw new Error("当前数据库驱动无法返回受影响行数。");
}
