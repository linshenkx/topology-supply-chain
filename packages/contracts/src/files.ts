export interface FileDownloadQuery {
  id?: string;
}

export const fileDownloadQuerySchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
  },
} as const;

export const fileDownloadResponseSchema = {
  type: "string",
  format: "binary",
} as const;
