export function toMysqlDateTime(value: string) {
  const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  if (!isoDateTime.test(value)) return value;
  return value.replace("T", " ").replace(/Z$/, "");
}
