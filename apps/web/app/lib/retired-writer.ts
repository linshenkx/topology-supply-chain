export function retiredPlatformRoute(migrationPath: string): Response {
  return Response.json(
    {
      code: "WRITER_MOVED",
      message: "This platform route has moved to the v1 API writer.",
      migrationPath,
    },
    {
      status: 410,
      headers: {
        "cache-control": "no-store",
        link: `<${migrationPath}>; rel="successor-version"`,
      },
    },
  );
}
