type UpsertSet = Record<string, unknown>;

type CrossDialectUpsertBuilder = {
  onConflictDoUpdate?: (options: {
    target: unknown;
    set: UpsertSet;
  }) => PromiseLike<unknown>;
  onDuplicateKeyUpdate?: (options: {
    set: UpsertSet;
  }) => PromiseLike<unknown>;
};

/**
 * D1/SQLite and RDS MySQL expose different Drizzle upsert methods. The
 * application database is selected at runtime, so keep that distinction out
 * of authentication routes and choose the supported method on the real
 * builder instance.
 */
export async function executeUpsert(
  insertBuilder: unknown,
  options: { conflictTarget: unknown; set: UpsertSet },
) {
  const builder = insertBuilder as CrossDialectUpsertBuilder;
  if (typeof builder.onConflictDoUpdate === "function") {
    return await builder.onConflictDoUpdate({
      target: options.conflictTarget,
      set: options.set,
    });
  }
  if (typeof builder.onDuplicateKeyUpdate === "function") {
    return await builder.onDuplicateKeyUpdate({ set: options.set });
  }
  throw new Error("当前数据库驱动不支持更新或新增记录。");
}
