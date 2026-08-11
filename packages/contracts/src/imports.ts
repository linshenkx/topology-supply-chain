export const importDiffSchemaId = "ImportDiff";

export type ImportDiffJsonValue =
  | boolean
  | number
  | string
  | null
  | ImportDiffJsonValue[]
  | { [key: string]: ImportDiffJsonValue };

export interface ImportDiffAddedOrRemoved {
  key: string;
  value: { [key: string]: ImportDiffJsonValue };
}

export interface ImportDiffFieldChange {
  field: string;
  oldValue: ImportDiffJsonValue;
  newValue: ImportDiffJsonValue;
}

export interface ImportDiffChanged {
  key: string;
  fields: ImportDiffFieldChange[];
}

export interface ImportDiffResponse {
  added: ImportDiffAddedOrRemoved[];
  changed: ImportDiffChanged[];
  removed: ImportDiffAddedOrRemoved[];
  preview?: true;
}

const jsonValueSchema = {
  anyOf: [
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    { type: "null" },
    { type: "array" },
    { type: "object", additionalProperties: true },
  ],
} as const;

const addedOrRemovedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "value"],
  properties: {
    key: { type: "string" },
    value: { type: "object", additionalProperties: true },
  },
} as const;

export const importDiffResponseSchema = {
  $id: importDiffSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["added", "changed", "removed"],
  properties: {
    added: {
      type: "array",
      maxItems: 5_000,
      items: addedOrRemovedSchema,
    },
    changed: {
      type: "array",
      maxItems: 5_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "fields"],
        properties: {
          key: { type: "string" },
          fields: {
            type: "array",
            maxItems: 500,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["field", "oldValue", "newValue"],
              properties: {
                field: { type: "string", minLength: 1 },
                oldValue: jsonValueSchema,
                newValue: jsonValueSchema,
              },
            },
          },
        },
      },
    },
    removed: {
      type: "array",
      maxItems: 5_000,
      items: addedOrRemovedSchema,
    },
    preview: { const: true },
  },
} as const;
