import { describe, expect, it } from 'vitest';

import {
  concat,
  exposableOutput,
  exposeOutputs,
  opTypeHistogram,
  protoFields,
  readVarint,
  summariseGraph,
  writeVarint,
  type GraphNode,
  type GraphSummary,
} from '../src/diagnostics/onnx-graph.ts';

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
