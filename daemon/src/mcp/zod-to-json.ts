/**
 * Minimal Zod → JSON Schema converter for MCP tool descriptions.
 *
 * We intentionally do not pull in zod-to-json-schema as a dep — we only need
 * the subset used in our tool args: object/string/number/boolean/array/enum/
 * union/optional/default/record. This keeps the dependency surface tight.
 */
import { z, ZodTypeAny } from "zod";

type JsonSchema = Record<string, unknown>;

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  return walk(schema);
}

function walk(s: ZodTypeAny): JsonSchema {
  const def = (s as unknown as { _def: { typeName: string } })._def;
  const t = def.typeName;
  switch (t) {
    case "ZodString": return { type: "string" };
    case "ZodNumber": return { type: "number" };
    case "ZodBoolean": return { type: "boolean" };
    case "ZodLiteral": {
      const lit = (def as unknown as { value: unknown }).value;
      return { const: lit };
    }
    case "ZodEnum": {
      const values = (def as unknown as { values: string[] }).values;
      return { type: "string", enum: values };
    }
    case "ZodArray": {
      const item = (def as unknown as { type: ZodTypeAny }).type;
      return { type: "array", items: walk(item) };
    }
    case "ZodObject": {
      const shape = (s as unknown as z.AnyZodObject).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        const child = v as ZodTypeAny;
        properties[k] = walk(child);
        if (!child.isOptional()) required.push(k);
      }
      return { type: "object", properties, required };
    }
    case "ZodOptional":
    case "ZodDefault":
    case "ZodNullable": {
      const inner = (def as unknown as { innerType: ZodTypeAny }).innerType;
      return walk(inner);
    }
    case "ZodUnion": {
      const options = (def as unknown as { options: ZodTypeAny[] }).options;
      return { oneOf: options.map(walk) };
    }
    case "ZodRecord":
      return { type: "object", additionalProperties: true };
    case "ZodAny":
    case "ZodUnknown":
      return {};
    default:
      return {};
  }
}
