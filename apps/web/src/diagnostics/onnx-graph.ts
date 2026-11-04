/**
 * Just enough of the ONNX protobuf to do two things with no dependency: list a
 * graph's nodes in their stored order, and add intermediate tensors to the
 * graph's outputs so a backend can be asked what it computed partway through.
 *
 * Only the top level is re-encoded. The graph's own bytes, every initializer
 * included, are copied through untouched, so editing a 21 MiB piece costs one
 * copy and no parsing of its weights.
 *
 * Field numbers are onnx.proto3's: ModelProto.graph 7; GraphProto.node 1,
 * initializer 5, input 11, output 12; NodeProto.input 1, output 2, name 3,
 * op_type 4, attribute 5; AttributeProto.name 1, i 3, g 6, graphs 11;
 * TensorProto.data_type 2, raw_data 9; ValueInfoProto.name 1.
 */

const MODEL_GRAPH = 7;
const GRAPH_NODE = 1;
const GRAPH_INITIALIZER = 5;
const GRAPH_INPUT = 11;
const GRAPH_OUTPUT = 12;
const NODE_INPUT = 1;
const NODE_OUTPUT = 2;
const NODE_NAME = 3;
const NODE_OP_TYPE = 4;
const NODE_ATTRIBUTE = 5;
const ATTRIBUTE_NAME = 1;
const ATTRIBUTE_INT = 3;
const ATTRIBUTE_GRAPH = 6;
const ATTRIBUTE_GRAPHS = 11;
const TENSOR_DATA_TYPE = 2;
const TENSOR_RAW_DATA = 9;
const VALUE_INFO_NAME = 1;
const VALUE_INFO_TYPE = 2;
const TYPE_TENSOR = 1;
const TENSOR_TYPE_ELEM_TYPE = 1;

/** TensorProto.DataType, for reporting the piece's own precision. */
export const ELEM_TYPES: Readonly<Record<number, string>> = {
  1: 'float32',
  2: 'uint8',
  3: 'int8',
  4: 'uint16',
  5: 'int16',
  6: 'int32',
  7: 'int64',
  8: 'string',
  9: 'bool',
  10: 'float16',
  11: 'float64',
  12: 'uint32',
  13: 'uint64',
  16: 'bfloat16',
};

export interface ProtoField {
  readonly field: number;
  readonly wire: number;
  /** First byte of the tag, so a field can be spliced out whole. */
  readonly tagAt: number;
  /** First byte of the value, past any length prefix. */
  readonly start: number;
  /** One past the last byte of the value. */
  readonly end: number;
}

/**
 * Multiplies rather than shifts: a protobuf varint can exceed 32 bits, which
 * `<<` would silently wrap.
 */
export function readVarint(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  let scale = 1;
  let offset = at;
  for (let step = 0; step < 10; step += 1) {
    const byte = bytes[offset];
    if (byte === undefined) {
      throw new Error(`varint at ${String(at)} runs past the end of the buffer`);
    }
    offset += 1;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) {
      return { value, next: offset };
    }
    scale *= 128;
  }
  throw new Error(`varint at ${String(at)} is longer than 10 bytes`);
}

export function writeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`not encodable as a varint: ${String(value)}`);
  }
  const bytes: number[] = [];
  let rest = value;
  do {
    const byte = rest % 128;
    rest = Math.floor(rest / 128);
    bytes.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return Uint8Array.from(bytes);
}

/** One length-delimited field: tag, length, payload. */
export function encodeField(field: number, payload: Uint8Array): Uint8Array {
  return concat([writeVarint(field * 8 + 2), writeVarint(payload.length), payload]);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Walks one message's fields without decoding any of them. */
export function* protoFields(
  bytes: Uint8Array,
  from = 0,
  to: number = bytes.length,
): Generator<ProtoField, void, void> {
  let at = from;
  while (at < to) {
    const tagAt = at;
    const tag = readVarint(bytes, at);
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    at = tag.next;
    if (wire === 0) {
      const value = readVarint(bytes, at);
      yield { field, wire, tagAt, start: at, end: value.next };
      at = value.next;
    } else if (wire === 2) {
      const length = readVarint(bytes, at);
      const end = length.next + length.value;
      if (end > to) {
        throw new Error(`field ${String(field)} at ${String(tagAt)} claims more bytes than remain`);
      }
      yield { field, wire, tagAt, start: length.next, end };
      at = end;
    } else if (wire === 1 || wire === 5) {
      const end = at + (wire === 1 ? 8 : 4);
      yield { field, wire, tagAt, start: at, end };
      at = end;
    } else {
      throw new Error(`protobuf wire type ${String(wire)} is not supported here`);
    }
  }
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function readString(bytes: Uint8Array, field: ProtoField): string {
  return decoder.decode(bytes.subarray(field.start, field.end));
}

export interface GraphNode {
  /** Position in GraphProto.node, which ONNX requires to be topological. */
  readonly index: number;
  readonly name: string;
  readonly opType: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** Cast's `to`, so a precision boundary shows up without reading weights. */
  readonly castTo: number | null;
  /** An If or Loop body: its insides cannot be made graph outputs. */
  readonly hasSubgraph: boolean;
}

export interface GraphSummary {
  readonly nodes: readonly GraphNode[];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** elem_type name to count, so the piece's precision is a fact not a guess. */
  readonly initializerTypes: Readonly<Record<string, number>>;
  readonly initializerBytes: number;
}

/** The ModelProto field holding the graph. */
function graphField(model: Uint8Array): ProtoField {
  for (const field of protoFields(model)) {
    if (field.field === MODEL_GRAPH && field.wire === 2) {
      return field;
    }
  }
  throw new Error('no ModelProto.graph field: this is not an ONNX model');
}

function readNode(bytes: Uint8Array, node: ProtoField, index: number): GraphNode {
  const inputs: string[] = [];
  const outputs: string[] = [];
  let name = '';
  let opType = '';
  let castTo: number | null = null;
  let hasSubgraph = false;

  for (const field of protoFields(bytes, node.start, node.end)) {
    if (field.field === NODE_INPUT) {
      inputs.push(readString(bytes, field));
    } else if (field.field === NODE_OUTPUT) {
      outputs.push(readString(bytes, field));
    } else if (field.field === NODE_NAME) {
      name = readString(bytes, field);
    } else if (field.field === NODE_OP_TYPE) {
      opType = readString(bytes, field);
    } else if (field.field === NODE_ATTRIBUTE) {
      let attributeName = '';
      let attributeInt: number | null = null;
      for (const inner of protoFields(bytes, field.start, field.end)) {
        if (inner.field === ATTRIBUTE_NAME) {
          attributeName = readString(bytes, inner);
        } else if (inner.field === ATTRIBUTE_INT) {
          attributeInt = readVarint(bytes, inner.start).value;
        } else if (inner.field === ATTRIBUTE_GRAPH || inner.field === ATTRIBUTE_GRAPHS) {
          hasSubgraph = true;
        }
      }
      if (attributeName === 'to' && attributeInt !== null) {
        castTo = attributeInt;
      }
    }
  }
  return { index, name, opType, inputs, outputs, castTo, hasSubgraph };
}

export function summariseGraph(model: Uint8Array): GraphSummary {
  const graph = graphField(model);
  const nodes: GraphNode[] = [];
  const inputs: string[] = [];
  const outputs: string[] = [];
  const initializerTypes: Record<string, number> = {};
  let initializerBytes = 0;

  for (const field of protoFields(model, graph.start, graph.end)) {
    if (field.field === GRAPH_NODE) {
      nodes.push(readNode(model, field, nodes.length));
    } else if (field.field === GRAPH_INPUT || field.field === GRAPH_OUTPUT) {
      const into = field.field === GRAPH_INPUT ? inputs : outputs;
      for (const inner of protoFields(model, field.start, field.end)) {
        if (inner.field === VALUE_INFO_NAME) {
          into.push(readString(model, inner));
        }
      }
    } else if (field.field === GRAPH_INITIALIZER) {
      let elemType = 0;
      for (const inner of protoFields(model, field.start, field.end)) {
        if (inner.field === TENSOR_DATA_TYPE) {
          elemType = readVarint(model, inner.start).value;
        } else if (inner.field === TENSOR_RAW_DATA) {
          initializerBytes += inner.end - inner.start;
        }
      }
      const key = ELEM_TYPES[elemType] ?? `type-${String(elemType)}`;
      initializerTypes[key] = (initializerTypes[key] ?? 0) + 1;
    }
  }
  return { nodes, inputs, outputs, initializerTypes, initializerBytes };
}

/**
 * A ValueInfoProto for one graph output.
 *
 * Typeless by default, because ONNX Runtime then infers the type the way it
 * does for any intermediate. That matters for this model: it is fp16 except
 * for its convolutions, so declaring float32 everywhere would be wrong for
 * most of its tensors and the load would fail on a type mismatch.
 *
 * `elemType` is the fallback for a runtime that insists on a declared type. No
 * shape is written either way, so the rank stays unknown and inference fills
 * it in.
 */
function outputValueInfo(name: string, elemType: number | null): Uint8Array {
  const named = encodeField(VALUE_INFO_NAME, encoder.encode(name));
  if (elemType === null) {
    return encodeField(GRAPH_OUTPUT, named);
  }
  const tensorType = concat([writeVarint(TENSOR_TYPE_ELEM_TYPE * 8), writeVarint(elemType)]);
  const type = encodeField(VALUE_INFO_TYPE, encodeField(TYPE_TENSOR, tensorType));
  return encodeField(GRAPH_OUTPUT, concat([named, type]));
}

/**
 * The same model with `names` appended to GraphProto.output, so
 * `session.run` can be asked for them.
 *
 * One consequence to hold onto when reading a bisection: a tensor that is a
 * graph output cannot be fused away or computed in place, so this is not
 * byte-for-byte the graph that failed. Run the bisection with optimisation
 * `disabled`, where there was nothing to fuse anyway.
 */
export function exposeOutputs(
  model: Uint8Array,
  names: readonly string[],
  elemType: number | null = null,
): Uint8Array {
  if (names.length === 0) {
    return model;
  }
  const graph = graphField(model);
  const extra = concat(names.map((name) => outputValueInfo(name, elemType)));
  const payloadLength = graph.end - graph.start + extra.length;
  return concat([
    model.subarray(0, graph.tagAt),
    writeVarint(MODEL_GRAPH * 8 + 2),
    writeVarint(payloadLength),
    model.subarray(graph.start, graph.end),
    extra,
    model.subarray(graph.end),
  ]);
}

/** The tensor a bisection step would expose for a node, or null if it cannot. */
export function exposableOutput(node: GraphNode): string | null {
  if (node.hasSubgraph) {
    return null;
  }
  for (const name of node.outputs) {
    if (name !== '') {
      return name;
    }
  }
  return null;
}

/** op_type to count, for the report's one-line shape of the piece. */
export function opTypeHistogram(nodes: readonly GraphNode[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    counts[node.opType] = (counts[node.opType] ?? 0) + 1;
  }
  return counts;
}
