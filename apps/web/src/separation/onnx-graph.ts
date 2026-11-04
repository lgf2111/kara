/**
 * Just enough of the ONNX protobuf to do two things with no dependency: list a
 * graph's nodes in their stored order, and add intermediate tensors to the
 * graph's outputs so a backend can be asked what it computed partway through.
 *
 * It lives next to the separation worker rather than in `diagnostics/` because
 * the worker itself rewrites every htdemucs piece before handing it to WebGPU;
 * see onnx-fp32-island.ts.
 *
 * Only the top level is re-encoded. The graph's own bytes, every initializer
 * included, are copied through untouched, so editing a 21 MiB piece costs one
 * copy and no parsing of its weights.
 *
 * Field numbers are onnx.proto3's: ModelProto.graph 7; GraphProto.node 1,
 * initializer 5, input 11, output 12, value_info 13; NodeProto.input 1,
 * output 2, name 3, op_type 4, attribute 5; AttributeProto.name 1, f 2, i 3,
 * s 4, t 5, g 6, floats 7, ints 8, graphs 11, type 20; TensorProto.dims 1,
 * data_type 2, float_data 4, int64_data 7, name 8, raw_data 9;
 * ValueInfoProto.name 1, type 2.
 */

export const MODEL_GRAPH = 7;
export const GRAPH_NODE = 1;
export const GRAPH_INITIALIZER = 5;
export const GRAPH_INPUT = 11;
export const GRAPH_OUTPUT = 12;
export const GRAPH_VALUE_INFO = 13;
export const NODE_INPUT = 1;
export const NODE_OUTPUT = 2;
export const NODE_NAME = 3;
export const NODE_OP_TYPE = 4;
export const NODE_ATTRIBUTE = 5;
const ATTRIBUTE_NAME = 1;
const ATTRIBUTE_FLOAT = 2;
const ATTRIBUTE_INT = 3;
const ATTRIBUTE_STRING = 4;
const ATTRIBUTE_GRAPH = 6;
const ATTRIBUTE_FLOATS = 7;
const ATTRIBUTE_INTS = 8;
const ATTRIBUTE_GRAPHS = 11;
const ATTRIBUTE_TYPE = 20;
/** AttributeProto.AttributeType.INT, the only one written here. */
const ATTRIBUTE_TYPE_INT = 2;
const TENSOR_DIMS = 1;
const TENSOR_DATA_TYPE = 2;
const TENSOR_FLOAT_DATA = 4;
const TENSOR_INT64_DATA = 7;
const TENSOR_NAME = 8;
const TENSOR_RAW_DATA = 9;
const VALUE_INFO_NAME = 1;
const VALUE_INFO_TYPE = 2;
const TYPE_TENSOR = 1;
const TENSOR_TYPE_ELEM_TYPE = 1;

/** TensorProto.DataType.FLOAT, the type this module rewrites arithmetic into. */
export const FLOAT32 = 1;
export const FLOAT16 = 10;

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

/** One little-endian fixed32 as a float, for AttributeProto.f and float_data. */
export function readFloat32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + at, 4).getFloat32(0, true);
}

function readFloat16(bytes: Uint8Array, at: number): number {
  const half = new DataView(bytes.buffer, bytes.byteOffset + at, 2).getUint16(0, true);
  const sign = (half & 0x8000) === 0 ? 1 : -1;
  const exponent = (half & 0x7c00) >> 10;
  const fraction = half & 0x03ff;
  if (exponent === 0) {
    return sign * 2 ** -14 * (fraction / 1024);
  }
  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : Number.NaN;
  }
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
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

/**
 * One NodeProto.attribute, decoded for reporting and kept as bytes for
 * rewriting.
 *
 * `raw` is the whole field, tag and length included, so a node can be rebuilt
 * with different tensor names and byte-identical attributes. That matters for
 * `ints`: protobuf allows a repeated scalar field packed or unpacked, and
 * copying sidesteps the question of which this exporter chose.
 */
export interface NodeAttribute {
  readonly name: string;
  readonly ints: readonly number[];
  readonly int: number | null;
  readonly float: number | null;
  readonly string: string | null;
  readonly floats: readonly number[];
  readonly raw: Uint8Array;
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
  readonly attributes: readonly NodeAttribute[];
}

/**
 * One GraphProto.initializer. `values` is filled only for a tensor small
 * enough to be a constant rather than a weight, so reading a 21 MiB piece
 * still costs no decoding: the epsilon of a normalisation is worth printing
 * and a convolution kernel is not.
 */
export interface InitializerInfo {
  readonly name: string;
  readonly elemType: number;
  readonly dims: readonly number[];
  readonly byteLength: number;
  readonly values: readonly number[] | null;
}

export interface GraphSummary {
  readonly nodes: readonly GraphNode[];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** elem_type name to count, so the piece's precision is a fact not a guess. */
  readonly initializerTypes: Readonly<Record<string, number>>;
  readonly initializerBytes: number;
  readonly initializers: readonly InitializerInfo[];
  /**
   * elem_type for every tensor the graph declares: its inputs, its outputs and
   * its value_info. This exporter declares all of them, which is what makes a
   * precision rewrite checkable rather than hopeful.
   */
  readonly declaredTypes: ReadonlyMap<string, number>;
}

/** The ModelProto field holding the graph. */
export function graphField(model: Uint8Array): ProtoField {
  for (const field of protoFields(model)) {
    if (field.field === MODEL_GRAPH && field.wire === 2) {
      return field;
    }
  }
  throw new Error('no ModelProto.graph field: this is not an ONNX model');
}

function readAttribute(bytes: Uint8Array, field: ProtoField): NodeAttribute {
  let name = '';
  let int: number | null = null;
  let float: number | null = null;
  let text: string | null = null;
  const ints: number[] = [];
  const floats: number[] = [];

  for (const inner of protoFields(bytes, field.start, field.end)) {
    if (inner.field === ATTRIBUTE_NAME) {
      name = readString(bytes, inner);
    } else if (inner.field === ATTRIBUTE_INT) {
      int = readVarint(bytes, inner.start).value;
    } else if (inner.field === ATTRIBUTE_FLOAT) {
      float = readFloat32(bytes, inner.start);
    } else if (inner.field === ATTRIBUTE_STRING) {
      text = readString(bytes, inner);
    } else if (inner.field === ATTRIBUTE_INTS) {
      // Packed when the exporter packed it, one field per element when it did
      // not. Both are legal for a repeated scalar and both appear in the wild.
      if (inner.wire === 2) {
        let at = inner.start;
        while (at < inner.end) {
          const value = readVarint(bytes, at);
          ints.push(value.value);
          at = value.next;
        }
      } else {
        ints.push(readVarint(bytes, inner.start).value);
      }
    } else if (inner.field === ATTRIBUTE_FLOATS) {
      if (inner.wire === 2) {
        for (let at = inner.start; at + 4 <= inner.end; at += 4) {
          floats.push(readFloat32(bytes, at));
        }
      } else {
        floats.push(readFloat32(bytes, inner.start));
      }
    }
  }
  return {
    name,
    ints,
    int,
    float,
    string: text,
    floats,
    raw: bytes.subarray(field.tagAt, field.end),
  };
}

/** One attribute as a line of text, for the node table. */
export function attributeText(attribute: NodeAttribute): string {
  const parts: string[] = [];
  if (attribute.int !== null) {
    parts.push(String(attribute.int));
  }
  if (attribute.float !== null) {
    parts.push(String(attribute.float));
  }
  if (attribute.string !== null) {
    parts.push(attribute.string);
  }
  if (attribute.ints.length > 0) {
    parts.push(`[${attribute.ints.join(',')}]`);
  }
  if (attribute.floats.length > 0) {
    parts.push(`[${attribute.floats.join(',')}]`);
  }
  return `${attribute.name}=${parts.join(' ') || '?'}`;
}

/** Bytes per element, or null for a type this module will not decode. */
function elementBytes(elemType: number): number | null {
  if (elemType === 1 || elemType === 6 || elemType === 12) {
    return 4;
  }
  if (elemType === 10 || elemType === 16 || elemType === 4 || elemType === 5) {
    return 2;
  }
  if (elemType === 7 || elemType === 11 || elemType === 13) {
    return 8;
  }
  if (elemType === 2 || elemType === 3 || elemType === 9) {
    return 1;
  }
  return null;
}

function readRawValues(
  bytes: Uint8Array,
  raw: ProtoField,
  elemType: number,
  count: number,
): readonly number[] | null {
  const width = elementBytes(elemType);
  if (width === null || raw.end - raw.start < count * width) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + raw.start, count * width);
  const out: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (elemType === 1) {
      out.push(view.getFloat32(index * 4, true));
    } else if (elemType === 10) {
      out.push(readFloat16(bytes, raw.start + index * 2));
    } else if (elemType === 7) {
      out.push(Number(view.getBigInt64(index * 8, true)));
    } else if (elemType === 6) {
      out.push(view.getInt32(index * 4, true));
    } else if (elemType === 11) {
      out.push(view.getFloat64(index * 8, true));
    } else {
      return null;
    }
  }
  return out;
}

/**
 * One initializer. Values are decoded only below `valueLimit` elements, so the
 * constants of a normalisation come back and the weights of a convolution are
 * left as a byte count.
 */
function readInitializer(bytes: Uint8Array, field: ProtoField, valueLimit: number): InitializerInfo {
  let name = '';
  let elemType = 0;
  let byteLength = 0;
  const dims: number[] = [];
  let raw: ProtoField | null = null;
  let inline: ProtoField | null = null;

  for (const inner of protoFields(bytes, field.start, field.end)) {
    if (inner.field === TENSOR_DIMS) {
      if (inner.wire === 2) {
        let at = inner.start;
        while (at < inner.end) {
          const value = readVarint(bytes, at);
          dims.push(value.value);
          at = value.next;
        }
      } else {
        dims.push(readVarint(bytes, inner.start).value);
      }
    } else if (inner.field === TENSOR_DATA_TYPE) {
      elemType = readVarint(bytes, inner.start).value;
    } else if (inner.field === TENSOR_NAME) {
      name = readString(bytes, inner);
    } else if (inner.field === TENSOR_RAW_DATA) {
      raw = inner;
      byteLength = inner.end - inner.start;
    } else if (inner.field === TENSOR_FLOAT_DATA || inner.field === TENSOR_INT64_DATA) {
      inline = inner;
    }
  }

  let count = 1;
  for (const dim of dims) {
    count *= dim;
  }
  let values: readonly number[] | null = null;
  if (count <= valueLimit) {
    if (raw !== null) {
      values = readRawValues(bytes, raw, elemType, count);
    } else if (inline !== null) {
      const decoded: number[] = [];
      if (inline.field === TENSOR_FLOAT_DATA) {
        for (let at = inline.start; at + 4 <= inline.end; at += 4) {
          decoded.push(readFloat32(bytes, at));
        }
      } else {
        let at = inline.start;
        while (at < inline.end) {
          const value = readVarint(bytes, at);
          decoded.push(value.value);
          at = value.next;
        }
      }
      values = decoded;
    }
  }
  return { name, elemType, dims, byteLength, values };
}

/** ValueInfoProto: its name and, when it declares one, its elem_type. */
function readValueInfo(bytes: Uint8Array, field: ProtoField): { name: string; elemType: number | null } {
  let name = '';
  let elemType: number | null = null;
  for (const inner of protoFields(bytes, field.start, field.end)) {
    if (inner.field === VALUE_INFO_NAME) {
      name = readString(bytes, inner);
    } else if (inner.field === VALUE_INFO_TYPE) {
      for (const type of protoFields(bytes, inner.start, inner.end)) {
        if (type.field !== TYPE_TENSOR) {
          continue;
        }
        for (const tensor of protoFields(bytes, type.start, type.end)) {
          if (tensor.field === TENSOR_TYPE_ELEM_TYPE) {
            elemType = readVarint(bytes, tensor.start).value;
          }
        }
      }
    }
  }
  return { name, elemType };
}

function readNode(bytes: Uint8Array, node: ProtoField, index: number): GraphNode {
  const inputs: string[] = [];
  const outputs: string[] = [];
  const attributes: NodeAttribute[] = [];
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
      for (const inner of protoFields(bytes, field.start, field.end)) {
        if (inner.field === ATTRIBUTE_GRAPH || inner.field === ATTRIBUTE_GRAPHS) {
          hasSubgraph = true;
        }
      }
      const attribute = readAttribute(bytes, field);
      attributes.push(attribute);
      if (attribute.name === 'to' && attribute.int !== null) {
        castTo = attribute.int;
      }
    }
  }
  return { index, name, opType, inputs, outputs, castTo, hasSubgraph, attributes };
}

export function summariseGraph(model: Uint8Array, valueLimit = 16): GraphSummary {
  const graph = graphField(model);
  const nodes: GraphNode[] = [];
  const inputs: string[] = [];
  const outputs: string[] = [];
  const initializerTypes: Record<string, number> = {};
  const initializers: InitializerInfo[] = [];
  const declaredTypes = new Map<string, number>();
  let initializerBytes = 0;

  for (const field of protoFields(model, graph.start, graph.end)) {
    if (field.field === GRAPH_NODE) {
      nodes.push(readNode(model, field, nodes.length));
    } else if (
      field.field === GRAPH_INPUT ||
      field.field === GRAPH_OUTPUT ||
      field.field === GRAPH_VALUE_INFO
    ) {
      const declared = readValueInfo(model, field);
      if (declared.elemType !== null) {
        declaredTypes.set(declared.name, declared.elemType);
      }
      if (field.field === GRAPH_INPUT) {
        inputs.push(declared.name);
      } else if (field.field === GRAPH_OUTPUT) {
        outputs.push(declared.name);
      }
    } else if (field.field === GRAPH_INITIALIZER) {
      const initializer = readInitializer(model, field, valueLimit);
      initializers.push(initializer);
      initializerBytes += initializer.byteLength;
      const key = ELEM_TYPES[initializer.elemType] ?? `type-${String(initializer.elemType)}`;
      initializerTypes[key] = (initializerTypes[key] ?? 0) + 1;
    }
  }
  return {
    nodes,
    inputs,
    outputs,
    initializerTypes,
    initializerBytes,
    initializers,
    declaredTypes,
  };
}

/** Every name the graph already uses, so a rewrite can pick one it does not. */
export function usedNames(summary: GraphSummary): ReadonlySet<string> {
  const names = new Set<string>([...summary.inputs, ...summary.outputs, ...summary.declaredTypes.keys()]);
  for (const initializer of summary.initializers) {
    names.add(initializer.name);
  }
  for (const node of summary.nodes) {
    names.add(node.name);
    for (const name of [...node.inputs, ...node.outputs]) {
      if (name !== '') {
        names.add(name);
      }
    }
  }
  return names;
}

/**
 * A NodeProto. Attributes are handed over as encoded fields, so a rebuilt node
 * can carry the original's bytes rather than a re-encoding of them.
 */
export function encodeNode(node: {
  readonly name: string;
  readonly opType: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly attributes?: readonly Uint8Array[];
}): Uint8Array {
  return encodeField(
    GRAPH_NODE,
    concat([
      ...node.inputs.map((name) => encodeField(NODE_INPUT, encoder.encode(name))),
      ...node.outputs.map((name) => encodeField(NODE_OUTPUT, encoder.encode(name))),
      encodeField(NODE_NAME, encoder.encode(node.name)),
      encodeField(NODE_OP_TYPE, encoder.encode(node.opType)),
      ...(node.attributes ?? []),
    ]),
  );
}

/** A Cast node as a GraphProto.node field. */
export function encodeCast(
  name: string,
  input: string,
  output: string,
  to: number,
): Uint8Array {
  const attribute = encodeField(
    NODE_ATTRIBUTE,
    concat([
      encodeField(ATTRIBUTE_NAME, encoder.encode('to')),
      writeVarint(ATTRIBUTE_INT * 8),
      writeVarint(to),
      writeVarint(ATTRIBUTE_TYPE * 8),
      writeVarint(ATTRIBUTE_TYPE_INT),
    ]),
  );
  return encodeNode({ name, opType: 'Cast', inputs: [input], outputs: [output], attributes: [attribute] });
}

/**
 * What a rewrite does with one GraphProto field: keep it, drop it, or put
 * something else in its place. Returning bytes rather than editing in place is
 * what lets a node become several nodes without disturbing the stored order,
 * which ONNX requires to be topological.
 */
export type GraphFieldRewrite = (
  field: ProtoField,
  /** Position among fields of this number, so nodes can be addressed by index. */
  ordinal: number,
) => Uint8Array | null | undefined;

/**
 * The same model with its GraphProto rebuilt field by field. Anything the
 * rewrite does not speak for is copied byte for byte, initializers included,
 * so editing a 21 MiB piece still costs one copy and no weight parsing.
 */
export function rewriteGraph(model: Uint8Array, rewrite: GraphFieldRewrite): Uint8Array {
  const graph = graphField(model);
  const parts: Uint8Array[] = [];
  const ordinals = new Map<number, number>();

  for (const field of protoFields(model, graph.start, graph.end)) {
    const ordinal = ordinals.get(field.field) ?? 0;
    ordinals.set(field.field, ordinal + 1);
    const replacement = rewrite(field, ordinal);
    if (replacement === null) {
      continue;
    }
    parts.push(replacement ?? model.subarray(field.tagAt, field.end));
  }

  const payload = concat(parts);
  return concat([
    model.subarray(0, graph.tagAt),
    writeVarint(MODEL_GRAPH * 8 + 2),
    writeVarint(payload.length),
    payload,
    model.subarray(graph.end),
  ]);
}

/** The name a value_info, graph input or graph output field carries. */
export function valueInfoName(model: Uint8Array, field: ProtoField): string {
  return readValueInfo(model, field).name;
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
