import { describe, expect, it } from 'vitest';

import {
  attributeText,
  concat,
  encodeCast,
  encodeNode,
  exposableOutput,
  exposeOutputs,
  opTypeHistogram,
  protoFields,
  readVarint,
  rewriteGraph,
  summariseGraph,
  usedNames,
  writeVarint,
  type GraphNode,
  type GraphSummary,
} from '../src/separation/onnx-graph.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function nodeAt(summary: GraphSummary, index: number): GraphNode {
  const node = summary.nodes[index];
  if (node === undefined) {
    throw new Error(`the fixture has no node at ${String(index)}`);
  }
  return node;
}

/**
 * A length-delimited field: tag, length, payload. Built from `writeVarint`,
 * which is checked on its own below, rather than from `encodeField`, so the
 * fixture does not lean on the function that writes the edit under test.
 */
function bytesField(field: number, payload: Uint8Array): Uint8Array {
  return concat([writeVarint(field * 8 + 2), writeVarint(payload.length), payload]);
}

function stringField(field: number, value: string): Uint8Array {
  return bytesField(field, encoder.encode(value));
}

function varintField(field: number, value: number): Uint8Array {
  return concat([writeVarint(field * 8), writeVarint(value)]);
}

interface FakeNode {
  readonly name: string;
  readonly opType: string;
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly castTo?: number;
  readonly subgraph?: boolean;
}

/** GraphProto.node, with NodeProto's own field numbers. */
function nodeField(node: FakeNode): Uint8Array {
  const attributes: Uint8Array[] = [];
  if (node.castTo !== undefined) {
    attributes.push(bytesField(5, concat([stringField(1, 'to'), varintField(3, node.castTo)])));
  }
  if (node.subgraph === true) {
    attributes.push(bytesField(5, concat([stringField(1, 'body'), bytesField(6, new Uint8Array(0))])));
  }
  return bytesField(
    1,
    concat([
      ...(node.inputs ?? []).map((name) => stringField(1, name)),
      ...(node.outputs ?? []).map((name) => stringField(2, name)),
      stringField(3, node.name),
      stringField(4, node.opType),
      ...attributes,
    ]),
  );
}

function valueInfoField(field: number, name: string): Uint8Array {
  return bytesField(field, stringField(1, name));
}

function initializerField(name: string, elemType: number, rawBytes: number): Uint8Array {
  return bytesField(
    5,
    concat([varintField(2, elemType), stringField(8, name), bytesField(9, new Uint8Array(rawBytes))]),
  );
}

/**
 * A model with a field after the graph on purpose: the splice that adds
 * outputs has to keep whatever follows, and a producer name usually does.
 */
function fakeModel(nodes: readonly FakeNode[]): Uint8Array {
  const graph = concat([
    ...nodes.map(nodeField),
    stringField(2, 'tiny'),
    initializerField('w0', 10, 64),
    initializerField('w1', 10, 32),
    initializerField('w2', 1, 16),
    valueInfoField(11, 'mag'),
    valueInfoField(12, 'out'),
  ]);
  return concat([varintField(1, 9), bytesField(7, graph), stringField(2, 'kara-test')]);
}

function topLevelString(model: Uint8Array, field: number): string | null {
  for (const found of protoFields(model)) {
    if (found.field === field && found.wire === 2) {
      return decoder.decode(model.subarray(found.start, found.end));
    }
  }
  return null;
}

const NODES: readonly FakeNode[] = [
  { name: '/Cast', opType: 'Cast', inputs: ['mag'], outputs: ['cast0'], castTo: 10 },
  { name: '/encoder.0/Conv', opType: 'Conv', inputs: ['cast0', 'w0'], outputs: ['conv0'] },
  { name: '/norm', opType: 'InstanceNormalization', inputs: ['conv0', 'w1'], outputs: ['norm0'] },
  { name: '/loop', opType: 'Loop', inputs: ['norm0'], outputs: ['loop0'], subgraph: true },
  { name: '/add', opType: 'Add', inputs: ['norm0', 'loop0'], outputs: ['out'] },
];

describe('varints', () => {
  it('round trips values that need more than one byte', () => {
    for (const value of [0, 1, 127, 128, 300, 16383, 16384, 1_234_567, 2 ** 31, 2 ** 40]) {
      const encoded = writeVarint(value);
      expect(readVarint(encoded, 0)).toEqual({ value, next: encoded.length });
    }
  });

  it('refuses what it cannot encode', () => {
    expect(() => writeVarint(-1)).toThrow();
    expect(() => writeVarint(1.5)).toThrow();
  });

  it('refuses a varint that runs off the end', () => {
    expect(() => readVarint(Uint8Array.of(0x80, 0x80), 0)).toThrow(/past the end/u);
  });
});

describe('summariseGraph', () => {
  it('lists the nodes in their stored order with inputs, outputs and op types', () => {
    const summary = summariseGraph(fakeModel(NODES));

    expect(summary.nodes.map((node) => node.opType)).toEqual([
      'Cast',
      'Conv',
      'InstanceNormalization',
      'Loop',
      'Add',
    ]);
    expect(summary.nodes.map((node) => node.index)).toEqual([0, 1, 2, 3, 4]);
    expect(summary.nodes[1]?.inputs).toEqual(['cast0', 'w0']);
    expect(summary.nodes[4]?.outputs).toEqual(['out']);
    expect(summary.inputs).toEqual(['mag']);
    expect(summary.outputs).toEqual(['out']);
  });

  it('reads the precision facts off the graph rather than guessing them', () => {
    const summary = summariseGraph(fakeModel(NODES));

    expect(summary.nodes[0]?.castTo).toBe(10);
    expect(summary.nodes[1]?.castTo).toBeNull();
    expect(summary.initializerTypes).toEqual({ float16: 2, float32: 1 });
    expect(summary.initializerBytes).toBe(112);
  });

  it('marks a node whose attribute holds a subgraph', () => {
    const summary = summariseGraph(fakeModel(NODES));

    expect(summary.nodes[3]?.hasSubgraph).toBe(true);
    expect(summary.nodes[2]?.hasSubgraph).toBe(false);
  });

  it('refuses something that is not a model', () => {
    expect(() => summariseGraph(stringField(2, 'no graph here'))).toThrow(/not an ONNX model/u);
  });
});

describe('exposeOutputs', () => {
  it('adds the names to the graph outputs and leaves the rest alone', () => {
    const model = fakeModel(NODES);
    const edited = exposeOutputs(model, ['conv0', 'norm0']);
    const summary = summariseGraph(edited);

    expect(summary.outputs).toEqual(['out', 'conv0', 'norm0']);
    expect(summary.nodes.map((node) => node.name)).toEqual(NODES.map((node) => node.name));
    expect(summary.inputs).toEqual(['mag']);
    expect(summary.initializerTypes).toEqual({ float16: 2, float32: 1 });
  });

  it('keeps the top level fields on both sides of the graph', () => {
    const model = fakeModel(NODES);
    const edited = exposeOutputs(model, ['conv0']);

    expect(topLevelString(edited, 2)).toBe('kara-test');
    const irVersion = [...protoFields(edited)].find((found) => found.field === 1);
    expect(irVersion === undefined ? null : readVarint(edited, irVersion.start).value).toBe(9);
  });

  it('grows the model by only the ValueInfoProto it adds', () => {
    const model = fakeModel(NODES);
    const edited = exposeOutputs(model, ['conv0']);

    // Five name bytes inside two length-delimited headers of two bytes each.
    expect(edited.length).toBe(model.length + 9);
  });

  it('can declare an element type, for a runtime that will not infer one', () => {
    const model = fakeModel(NODES);
    const typed = exposeOutputs(model, ['conv0'], 10);

    expect(summariseGraph(typed).outputs).toEqual(['out', 'conv0']);
    // The nine typeless bytes, plus a TypeProto of six: tensor_type elem_type.
    expect(typed.length).toBe(model.length + 15);
    expect(topLevelString(typed, 2)).toBe('kara-test');
  });

  it('is the same model when nothing is asked for', () => {
    const model = fakeModel(NODES);

    expect(exposeOutputs(model, [])).toBe(model);
  });

  it('survives a graph long enough to need a multi-byte length', () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      name: `/node${String(index)}`,
      opType: 'Relu',
      inputs: [`t${String(index)}`],
      outputs: [`t${String(index + 1)}`],
    }));
    const edited = exposeOutputs(fakeModel(many), ['t200']);
    const summary = summariseGraph(edited);

    expect(summary.nodes).toHaveLength(400);
    expect(summary.outputs).toEqual(['out', 't200']);
    expect(topLevelString(edited, 2)).toBe('kara-test');
  });
});

describe('exposableOutput', () => {
  it('names the tensor a bisection step would ask for', () => {
    expect(exposableOutput(nodeAt(summariseGraph(fakeModel(NODES)), 1))).toBe('conv0');
  });

  it('refuses a node that owns a subgraph', () => {
    expect(exposableOutput(nodeAt(summariseGraph(fakeModel(NODES)), 3))).toBeNull();
  });

  it('skips an optional output left blank', () => {
    const summary = summariseGraph(
      fakeModel([{ name: '/drop', opType: 'Dropout', inputs: ['mag'], outputs: ['', 'kept'] }]),
    );

    expect(exposableOutput(nodeAt(summary, 0))).toBe('kept');
  });
});

describe('opTypeHistogram', () => {
  it('counts the shape of the piece', () => {
    expect(opTypeHistogram(summariseGraph(fakeModel(NODES)).nodes)).toEqual({
      Cast: 1,
      Conv: 1,
      InstanceNormalization: 1,
      Loop: 1,
      Add: 1,
    });
  });
});

describe('node attributes', () => {
  /** AttributeProto with ints packed into one field, as this exporter writes them. */
  function packedInts(name: string, values: readonly number[]): Uint8Array {
    return bytesField(
      5,
      concat([stringField(1, name), bytesField(8, concat(values.map((v) => writeVarint(v))))]),
    );
  }

  /** The same list as one field per element, which protobuf also allows. */
  function looseInts(name: string, values: readonly number[]): Uint8Array {
    return bytesField(5, concat([stringField(1, name), ...values.map((v) => varintField(8, v))]));
  }

  function floatAttribute(name: string, value: number): Uint8Array {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setFloat32(0, value, true);
    return bytesField(
      5,
      concat([stringField(1, name), concat([writeVarint(2 * 8 + 5), payload])]),
    );
  }

  function modelWith(attributes: readonly Uint8Array[]): Uint8Array {
    const node = bytesField(
      1,
      concat([
        stringField(1, 'in'),
        stringField(2, 'out'),
        stringField(3, '/node'),
        stringField(4, 'ReduceMean'),
        ...attributes,
      ]),
    );
    return concat([varintField(1, 8), bytesField(7, node)]);
  }

  it('reads a packed ints attribute', () => {
    const summary = summariseGraph(modelWith([packedInts('axes', [1, 2, 3])]));

    expect(summary.nodes[0]?.attributes[0]?.name).toBe('axes');
    expect(summary.nodes[0]?.attributes[0]?.ints).toEqual([1, 2, 3]);
  });

  it('reads an unpacked ints attribute the same way', () => {
    const summary = summariseGraph(modelWith([looseInts('axes', [1, 2, 3])]));

    expect(summary.nodes[0]?.attributes[0]?.ints).toEqual([1, 2, 3]);
  });

  it('reads an int and a float, which is where an epsilon lives', () => {
    const summary = summariseGraph(
      modelWith([varintAttribute('keepdims', 1), floatAttribute('epsilon', 1e-5)]),
    );
    const attributes = summary.nodes[0]?.attributes ?? [];

    expect(attributes[0]?.int).toBe(1);
    // Read as the float32 it is stored as, which is the number the model
    // actually holds: 1e-5 is not representable and this is what it rounds to.
    expect(attributes[1]?.float).toBe(0.000009999999747378752);
    expect(attributes.map(attributeText)).toEqual([
      'keepdims=1',
      'epsilon=0.000009999999747378752',
    ]);
  });

  it('keeps each attribute as the bytes it was read from', () => {
    const encoded = packedInts('axes', [1, 2]);
    const summary = summariseGraph(modelWith([encoded]));

    expect([...(summary.nodes[0]?.attributes[0]?.raw ?? [])]).toEqual([...encoded]);
  });

  /** AttributeProto.i, which the fixture above writes for `to` as well. */
  function varintAttribute(name: string, value: number): Uint8Array {
    return bytesField(5, concat([stringField(1, name), varintField(3, value)]));
  }
});

describe('initializers and declared types', () => {
  function tensor(name: string, elemType: number, dims: readonly number[], raw: Uint8Array): Uint8Array {
    return bytesField(
      5,
      concat([
        ...dims.map((dim) => varintField(1, dim)),
        varintField(2, elemType),
        stringField(8, name),
        bytesField(9, raw),
      ]),
    );
  }

  function typedValueInfo(field: number, name: string, elemType: number): Uint8Array {
    return bytesField(
      field,
      concat([stringField(1, name), bytesField(2, bytesField(1, varintField(1, elemType)))]),
    );
  }

  const halfOne = Uint8Array.of(0x00, 0x3c);
  const model = concat([
    varintField(1, 8),
    bytesField(
      7,
      concat([
        tensor('eps', 10, [], halfOne),
        tensor('weight', 1, [4096], new Uint8Array(16_384)),
        typedValueInfo(11, 'mag', 1),
        typedValueInfo(12, 'y', 1),
        typedValueInfo(13, 'mid', 10),
      ]),
    ),
  ]);

  it('decodes a scalar constant and leaves a weight as a byte count', () => {
    const summary = summariseGraph(model);

    expect(summary.initializers[0]).toEqual({
      name: 'eps',
      elemType: 10,
      dims: [],
      byteLength: 2,
      values: [1],
    });
    expect(summary.initializers[1]?.values).toBeNull();
    expect(summary.initializers[1]?.byteLength).toBe(16_384);
  });

  it('collects the elem_type of inputs, outputs and value_info alike', () => {
    const summary = summariseGraph(model);

    expect([...summary.declaredTypes.entries()].sort()).toEqual([
      ['mag', 1],
      ['mid', 10],
      ['y', 1],
    ]);
    expect(summary.inputs).toEqual(['mag']);
    expect(summary.outputs).toEqual(['y']);
  });

  it('lists every name the graph already uses', () => {
    expect([...usedNames(summariseGraph(model))].sort()).toEqual([
      'eps',
      'mag',
      'mid',
      'weight',
      'y',
    ]);
  });
});

describe('encodeCast and rewriteGraph', () => {
  it('writes a Cast the reader reads back', () => {
    const model = concat([varintField(1, 8), bytesField(7, encodeCast('/c', 'a', 'b', 1))]);
    const node = summariseGraph(model).nodes[0];

    expect(node?.opType).toBe('Cast');
    expect(node?.name).toBe('/c');
    expect(node?.inputs).toEqual(['a']);
    expect(node?.outputs).toEqual(['b']);
    expect(node?.castTo).toBe(1);
  });

  it('writes a node that carries somebody else attribute bytes', () => {
    const original = summariseGraph(fakeModel(NODES)).nodes[0];
    const rebuilt = concat([
      varintField(1, 8),
      bytesField(
        7,
        encodeNode({
          name: '/copy',
          opType: 'Cast',
          inputs: ['x'],
          outputs: ['y'],
          attributes: (original?.attributes ?? []).map((attribute) => attribute.raw),
        }),
      ),
    ]);

    expect(summariseGraph(rebuilt).nodes[0]?.castTo).toBe(10);
  });

  it('copies every field it is not asked about', () => {
    const model = fakeModel(NODES);
    const same = rewriteGraph(model, () => undefined);

    expect([...same]).toEqual([...model]);
  });

  it('replaces one node with several, in place', () => {
    const model = fakeModel(NODES);
    const edited = rewriteGraph(model, (field, ordinal) =>
      field.field === 1 && ordinal === 2
        ? concat([
            encodeCast('/pre', 'conv0', 'conv0f', 1),
            encodeNode({ name: '/norm', opType: 'InstanceNormalization', inputs: ['conv0f', 'w1'], outputs: ['norm0'] }),
          ])
        : undefined,
    );
    const summary = summariseGraph(edited);

    expect(summary.nodes.map((node) => node.name)).toEqual([
      '/Cast',
      '/encoder.0/Conv',
      '/pre',
      '/norm',
      '/loop',
      '/add',
    ]);
    expect(topLevelString(edited, 2)).toBe('kara-test');
  });

  it('drops a field by returning null', () => {
    const model = fakeModel(NODES);
    const edited = rewriteGraph(model, (field) => (field.field === 5 ? null : undefined));

    expect(summariseGraph(edited).initializerTypes).toEqual({});
    expect(summariseGraph(edited).nodes).toHaveLength(NODES.length);
  });
});
