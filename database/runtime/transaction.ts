import { isAliyunRuntime } from "@topology/shared-config/runtime-env";

type TransactionCapable<TDb> = TDb & {
  transaction?: <T>(callback: (tx: TDb) => Promise<T>) => Promise<T>;
};

/**
 * RDS operations use a real database transaction. The local D1 preview remains
 * non-transactional because it contains no production data and D1's transaction
 * model is different; production invariants are enforced on RDS.
 */
export async function withDbTransaction<TDb, TResult>(
  db: TDb,
  work: (tx: TDb) => Promise<TResult>,
) {
  const capable = db as TransactionCapable<TDb>;
  if (isAliyunRuntime() && typeof capable.transaction === "function") {
    return capable.transaction(work);
  }
  return work(db);
}
