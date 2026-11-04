import { describe, expect, it } from 'vitest';

import {
  findNormalisationIslands,
  patchNormalisationIslands,
  type Island,
} from '../src/diagnostics/onnx-fp32-island.ts';
import {
  concat,
  summariseGraph,
  writeVarint,
  type GraphNode,
  type GraphSummary,
} from '../src/diagnostics/onnx-graph.ts';

/**
 * A tiny model built from the same protobuf primitives the reader uses, so the
 * rewrite is checked against bytes rather than against a mock. The shape is
 * htdemucs' input normalisation: ReduceMean, Sub, Pow, ReduceMean, Clip, Sqrt,
 * Add, Div, with the mean and the standard deviation also leaving the island
 * through an Unsqueeze and the result leaving it through a Cast.
 */

const encoder = new TextEncoder();

function bytesField(field: number, payload: Uint8Array): Uint8Array {
  return concat([writeVarint(field * 8 + 2), writeVarint(payload.length), payload]);
}

function stringField(field: number, value: string): Uint8Array {
  return bytesField(field, encoder.encode(value));
}

function varintField(field: number, value: number): Uint8Array {
  return concat([writeVarint(field * 8), writeVarint(value)]);
}

/** AttributeProto with a name, packed ints and type INTS. */
function intsAttribute(name: string, values: readonly number[]): Uint8Array {
  return bytesField(
    5,
    concat([
      stringField(1, name),
      bytesField(8, concat(values.map((value) => writeVarint(value)))),
      varintField(20, 7),
    ]),
  );
}

function intAttribute(name: string, value: number): Uint8Array {
  return bytesField(5, concat([stringField(1, name), varintField(3, value), varintField(20, 2)]));
}

interface FakeNode {
  readonly name: string;
  readonly opType: string;
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly attributes?: readonly Uint8Array[];
}

function nodeField(node: FakeNode): Uint8Array {
  return bytesField(
    1,
    concat([
      ...(node.inputs ?? []).map((name) => stringField(1, name)),
      ...(node.outputs ?? []).map((name) => stringField(2, name)),
      stringField(3, node.name),
      stringField(4, node.opType),
      ...(node.attributes ?? []),
    ]),
  );
}

/** ValueInfoProto: name, and a TypeProto declaring only the elem_type. */
function valueInfo(field: number, name: string, elemType: number | null): Uint8Array {
  const named = stringField(1, name);
  if (elemType === null) {
    return bytesField(field, named);
  }
  return bytesField(field, concat([named, bytesField(2, bytesField(1, varintField(1, elemType)))]));
}

function initializer(name: string, elemType: number, bytes: number): Uint8Array {
  return bytesField(
    5,
    concat([varintField(2, elemType), stringField(8, name), bytesField(9, new Uint8Array(bytes))]),
  );
}

const FLOAT32 = 1;
const FLOAT16 = 10;

const ISLAND: readonly FakeNode[] = [
  { name: '/in', opType: 'Cast', inputs: ['mix'], outputs: ['x'], attributes: [intAttribute('to', 10)] },
  {
    name: '/ReduceMean',
    opType: 'ReduceMean',
    inputs: ['x'],
    outputs: ['mean'],
    attributes: [intAttribute('keepdims', 1), intsAttribute('axes', [1, 2])],
  },
  { name: '/Unsqueeze_mean', opType: 'Unsqueeze', inputs: ['mean', 'one'], outputs: ['mean_out'] },
  { name: '/Sub', opType: 'Sub', inputs: ['x', 'mean'], outputs: ['diff'] },
  { name: '/Pow', opType: 'Pow', inputs: ['diff', 'two'], outputs: ['square'] },
  {
    name: '/ReduceMean_1',
    opType: 'ReduceMean',
    inputs: ['square'],
    outputs: ['variance'],
    attributes: [intAttribute('keepdims', 1), intsAttribute('axes', [1, 2])],
  },
  { name: '/Clip', opType: 'Clip', inputs: ['variance', 'zero', ''], outputs: ['clipped'] },
  { name: '/Sqrt', opType: 'Sqrt', inputs: ['clipped'], outputs: ['std'] },
  { name: '/Unsqueeze_std', opType: 'Unsqueeze', inputs: ['std', 'one'], outputs: ['std_out'] },
  { name: '/Add', opType: 'Add', inputs: ['std', 'eps'], outputs: ['denom'] },
  { name: '/Div', opType: 'Div', inputs: ['diff', 'denom'], outputs: ['normalised'] },
  {
    name: '/out',
    opType: 'Cast',
    inputs: ['normalised'],
    outputs: ['y'],
    attributes: [intAttribute('to', 1)],
  },
];

const DECLARED: readonly (readonly [string, number])[] = [
  ['x', FLOAT16],
  ['mean', FLOAT16],
  ['diff', FLOAT16],
  ['square', FLOAT16],
  ['variance', FLOAT16],
  ['clipped', FLOAT16],
  ['std', FLOAT16],
  ['denom', FLOAT16],
  ['normalised', FLOAT16],
];

function fakeModel(
  nodes: readonly FakeNode[] = ISLAND,
  declared: readonly (readonly [string, number])[] = DECLARED,
): Uint8Array {
  const graph = concat([
    ...nodes.map(nodeField),
    stringField(2, 'tiny'),
    initializer('two', FLOAT16, 2),
    initializer('zero', FLOAT16, 2),
    initializer('eps', FLOAT16, 2),
    initializer('one', 7, 8),
    valueInfo(11, 'mix', FLOAT32),
    valueInfo(12, 'y', FLOAT32),
    valueInfo(12, 'mean_out', FLOAT32),
    valueInfo(12, 'std_out', FLOAT32),
    ...declared.map(([name, elemType]) => valueInfo(13, name, elemType)),
  ]);
  return concat([varintField(1, 8), bytesField(7, graph), stringField(2, 'kara-test')]);
}

function roles(island: Island): Record<string, string> {
  return Object.fromEntries(island.steps.map((step) => [step.role, step.nodeName]));
}

function nodeNamed(summary: GraphSummary, name: string): GraphNode {
  const node = summary.nodes.find((item) => item.name === name);
  if (node === undefined) {
    throw new Error(`the patched graph has no node named ${name}`);
  }
  return node;
}

function nodeProducing(summary: GraphSummary, tensor: string): GraphNode {
  const node = summary.nodes.find((item) => item.outputs.includes(tensor));
  if (node === undefined) {
    throw new Error(`nothing in the patched graph produces ${tensor}`);
  }
  return node;
}

describe('findNormalisationIslands', () => {
  it('matches the eight nodes through the data flow and names each role', () => {
    const islands = findNormalisationIslands(summariseGraph(fakeModel()));

    expect(islands).toHaveLength(1);
    const island = islands[0];
    if (island === undefined) {
      throw new Error('no island');
    }
    expect(island.input).toBe('x');
    expect(island.inputElemType).toBe(FLOAT16);
    expect(island.axes).toEqual([1, 2]);
    expect(island.keepDims).toBe(1);
    expect(roles(island)).toEqual({
      mean: '/ReduceMean',
      diff: '/Sub',
      square: '/Pow',
      variance: '/ReduceMean_1',
      clip: '/Clip',
      std: '/Sqrt',
      denom: '/Add',
      result: '/Div',
    });
  });

  it('keeps the steps in stored node order, so a rewrite stays topological', () => {
    const islands = findNormalisationIslands(summariseGraph(fakeModel()));
    const indices = islands[0]?.steps.map((step) => step.nodeIndex) ?? [];

    expect(indices).toEqual([...indices].sort((left, right) => left - right));
  });

  it('matches without the Clip, which not every export emits', () => {
    const withoutClip = ISLAND.filter((node) => node.opType !== 'Clip').map((node) =>
      node.name === '/Sqrt' ? { ...node, inputs: ['variance'] } : node,
    );
    const islands = findNormalisationIslands(summariseGraph(fakeModel(withoutClip)));

    expect(islands).toHaveLength(1);
    expect(roles(islands[0] ?? ({} as Island)).std).toBe('/Sqrt');
    expect(roles(islands[0] ?? ({} as Island)).clip).toBeUndefined();
  });

  it('finds both islands when a graph normalises two inputs', () => {
    const second = ISLAND.slice(1).map((node) => ({
      ...node,
      name: `${node.name}_b`,
      inputs: (node.inputs ?? []).map((name) =>
        name === '' || ['two', 'zero', 'eps', 'one'].includes(name) ? name : `${name}_b`,
      ),
      outputs: (node.outputs ?? []).map((name) => `${name}_b`),
    }));
    const nodes = [
      ...ISLAND,
      {
        name: '/in_b',
        opType: 'Cast',
        inputs: ['mix'],
        outputs: ['x_b'],
        attributes: [intAttribute('to', 10)],
      },
      ...second,
    ];
    const declared = [...DECLARED, ...DECLARED.map(([name, type]) => [`${name}_b`, type] as const)];
    const islands = findNormalisationIslands(summariseGraph(fakeModel(nodes, declared)));

    expect(islands.map((island) => island.input)).toEqual(['x', 'x_b']);
  });

  it('refuses a chain whose two reductions are over different axes', () => {
    const mismatched = ISLAND.map((node) =>
      node.name === '/ReduceMean_1'
        ? { ...node, attributes: [intAttribute('keepdims', 1), intsAttribute('axes', [1])] }
        : node,
    );

    expect(findNormalisationIslands(summariseGraph(fakeModel(mismatched)))).toEqual([]);
  });

  it('refuses a Div that divides something other than the centred tensor', () => {
    const elsewhere = ISLAND.map((node) =>
      node.name === '/Div' ? { ...node, inputs: ['x', 'denom'] } : node,
    );

    expect(findNormalisationIslands(summariseGraph(fakeModel(elsewhere)))).toEqual([]);
  });

  it('refuses a Sub that centres on somebody else mean', () => {
    const nodes = [
      ...ISLAND.filter((node) => node.name !== '/ReduceMean'),
      { name: '/elsewhere', opType: 'ReduceMean', inputs: ['other'], outputs: ['mean'] },
    ];

    expect(findNormalisationIslands(summariseGraph(fakeModel(nodes)))).toEqual([]);
  });
});

describe('patchNormalisationIslands', () => {
  it('casts the island input to float32 once', () => {
    const patch = patchNormalisationIslands(fakeModel());
    const summary = summariseGraph(patch.bytes);
    const casts = summary.nodes.filter(
      (node) => node.opType === 'Cast' && node.inputs[0] === 'x' && node.castTo === 1,
    );

    expect(patch.changed).toBe(true);
    expect(casts).toHaveLength(1);
    expect(casts[0]?.outputs).toEqual([`x${patch.suffix}`]);
  });

  it('rebuilds every island node on the float32 tensors', () => {
    const patch = patchNormalisationIslands(fakeModel());
    const summary = summariseGraph(patch.bytes);
    const fp32 = (name: string): string => `${name}${patch.suffix}`;

    expect(nodeNamed(summary, fp32('/ReduceMean')).inputs).toEqual([fp32('x')]);
    expect(nodeNamed(summary, fp32('/Sub')).inputs).toEqual([fp32('x'), fp32('mean')]);
    expect(nodeNamed(summary, fp32('/Pow')).inputs).toEqual([fp32('diff'), fp32('two')]);
    expect(nodeNamed(summary, fp32('/ReduceMean_1')).inputs).toEqual([fp32('square')]);
    expect(nodeNamed(summary, fp32('/Sqrt')).inputs).toEqual([fp32('clipped')]);
    expect(nodeNamed(summary, fp32('/Add')).inputs).toEqual([fp32('std'), fp32('eps')]);
    expect(nodeNamed(summary, fp32('/Div')).inputs).toEqual([fp32('diff'), fp32('denom')]);
    expect(nodeNamed(summary, fp32('/Div')).outputs).toEqual([fp32('normalised')]);
  });

  it('converts each constant once and leaves an unused Clip bound empty', () => {
    const patch = patchNormalisationIslands(fakeModel());
    const summary = summariseGraph(patch.bytes);

    expect(nodeNamed(summary, `/Clip${patch.suffix}`).inputs).toEqual([
      `variance${patch.suffix}`,
      `zero${patch.suffix}`,
      '',
    ]);
    for (const constant of ['two', 'zero', 'eps']) {
      const casts = summary.nodes.filter(
        (node) => node.opType === 'Cast' && node.inputs[0] === constant,
      );
      expect(casts).toHaveLength(1);
      expect(casts[0]?.castTo).toBe(FLOAT32);
    }
  });

  it('leaves the int64 shape input of an Unsqueeze alone', () => {
    const patch = patchNormalisationIslands(fakeModel());
    const summary = summariseGraph(patch.bytes);

    expect(nodeNamed(summary, '/Unsqueeze_mean').inputs).toEqual(['mean', 'one']);
    expect(summary.nodes.some((node) => node.inputs[0] === 'one')).toBe(false);
  });

  it('casts back to the declared type every tensor something outside reads', () => {
    const patch = patchNormalisationIslands(fakeModel());
    const summary = summariseGraph(patch.bytes);
    const island = patch.islands[0];

    expect(island?.boundary).toEqual([
      { tensor: 'mean', elemType: FLOAT16 },
      { tensor: 'std', elemType: FLOAT16 },
      { tensor: 'normalised', elemType: FLOAT16 },
    ]);
    for (const tensor of ['mean', 'std', 'normalised']) {
      const back = nodeProducing(summary, tensor);
      expect(back.opType).toBe('Cast');
      expect(back.castTo).toBe(FLOAT16);
      expect(back.inputs).toEqual([`${tensor}${patch.suffix}`]);
    }
  });

  it('leaves the island internals in float32, with nothing cast back', () => {
    const patch = patchNormalisationIslands(fakeModel());

    expect(patch.islands[0]?.internal).toEqual(['diff', 'square', 'variance', 'clipped', 'denom']);
  });

  it('keeps the names and types of everything outside the island', () => {
    const before = summariseGraph(fakeModel());
    const after = summariseGraph(patchNormalisationIslands(fakeModel()).bytes);

    expect(after.inputs).toEqual(before.inputs);
    expect(after.outputs).toEqual(before.outputs);
    expect(after.initializerTypes).toEqual(before.initializerTypes);
    expect(after.initializerBytes).toEqual(before.initializerBytes);
    expect(nodeNamed(after, '/in').outputs).toEqual(['x']);
    expect(nodeNamed(after, '/out').inputs).toEqual(['normalised']);
    expect(nodeNamed(after, '/Unsqueeze_std').inputs).toEqual(['std', 'one']);
  });

  it('stops declaring the tensors it stopped producing', () => {
    const patch = patchNormalisationIslands(fakeModel());
    const after = summariseGraph(patch.bytes);

    for (const name of ['diff', 'square', 'variance', 'clipped', 'denom']) {
      expect(after.declaredTypes.has(name)).toBe(false);
    }
    // The boundary tensors still exist, so their declarations still hold.
    for (const name of ['x', 'mean', 'std', 'normalised']) {
      expect(after.declaredTypes.get(name)).toBe(FLOAT16);
    }
  });

  it('declares every tensor it kept and produces every tensor it declares', () => {
    const after = summariseGraph(patchNormalisationIslands(fakeModel()).bytes);
    const produced = new Set([
      ...after.inputs,
      ...after.initializers.map((item) => item.name),
      ...after.nodes.flatMap((node) => node.outputs),
    ]);

    for (const name of after.declaredTypes.keys()) {
      expect(produced.has(name)).toBe(true);
    }
    for (const node of after.nodes) {
      for (const input of node.inputs) {
        if (input !== '') {
          expect(produced.has(input)).toBe(true);
        }
      }
    }
  });

  it('emits every node after the nodes it reads from', () => {
    const after = summariseGraph(patchNormalisationIslands(fakeModel()).bytes);
    const seen = new Set<string>([...after.inputs, ...after.initializers.map((item) => item.name)]);

    for (const node of after.nodes) {
      for (const input of node.inputs) {
        if (input !== '') {
          expect(seen.has(input)).toBe(true);
        }
      }
      for (const output of node.outputs) {
        seen.add(output);
      }
    }
  });

  it('gives every node and every tensor one producer', () => {
    const after = summariseGraph(patchNormalisationIslands(fakeModel()).bytes);
    const names = after.nodes.map((node) => node.name);
    const outputs = after.nodes.flatMap((node) => node.outputs).filter((name) => name !== '');

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(outputs).size).toBe(outputs.length);
  });

  it('keeps the attributes of a rebuilt node byte for byte', () => {
    const before = summariseGraph(fakeModel());
    const patch = patchNormalisationIslands(fakeModel());
    const after = summariseGraph(patch.bytes);
    const original = nodeNamed(before, '/ReduceMean_1');
    const rebuilt = nodeNamed(after, `/ReduceMean_1${patch.suffix}`);

    expect(rebuilt.attributes.map((item) => [...item.raw])).toEqual(
      original.attributes.map((item) => [...item.raw]),
    );
    expect(rebuilt.attributes.find((item) => item.name === 'axes')?.ints).toEqual([1, 2]);
    expect(rebuilt.attributes.find((item) => item.name === 'keepdims')?.int).toBe(1);
  });

  it('keeps the top level fields on both sides of the graph', () => {
    const patch = patchNormalisationIslands(fakeModel());
    const summary = summariseGraph(patch.bytes);

    expect(summary.nodes.length).toBeGreaterThan(ISLAND.length);
    // ir_version and producer_name sit either side of GraphProto.
    const text = new TextDecoder().decode(patch.bytes);
    expect(text).toContain('kara-test');
  });

  it('is generic over both islands when a graph has two', () => {
    const second = ISLAND.slice(1).map((node) => ({
      ...node,
      name: `${node.name}_b`,
      inputs: (node.inputs ?? []).map((name) =>
        name === '' || ['two', 'zero', 'eps', 'one'].includes(name) ? name : `${name}_b`,
      ),
      outputs: (node.outputs ?? []).map((name) => `${name}_b`),
    }));
    const nodes = [
      ...ISLAND,
      {
        name: '/in_b',
        opType: 'Cast',
        inputs: ['mix'],
        outputs: ['x_b'],
        attributes: [intAttribute('to', 10)],
      },
      ...second,
    ];
    const declared = [...DECLARED, ...DECLARED.map(([name, type]) => [`${name}_b`, type] as const)];
    const patch = patchNormalisationIslands(fakeModel(nodes, declared));
    const after = summariseGraph(patch.bytes);

    expect(patch.islands.map((island) => island.input)).toEqual(['x', 'x_b']);
    // The shared exponent is converted once, in front of its first reader.
    expect(after.nodes.filter((node) => node.inputs[0] === 'two')).toHaveLength(1);
    const seen = new Set<string>([...after.inputs, ...after.initializers.map((item) => item.name)]);
    for (const node of after.nodes) {
      for (const input of node.inputs) {
        if (input !== '') {
          expect(seen.has(input)).toBe(true);
        }
      }
      for (const output of node.outputs) {
        seen.add(output);
      }
    }
  });

  it('leaves a float32 island alone and says why', () => {
    const declared = DECLARED.map(([name]) => [name, FLOAT32] as const);
    const model = fakeModel(ISLAND, declared);
    const patch = patchNormalisationIslands(model);

    expect(patch.changed).toBe(false);
    expect(patch.bytes).toBe(model);
    expect(patch.islands).toEqual([]);
    expect(patch.skipped.map((island) => island.reason)).toEqual(['already float32']);
  });

  it('says so when the graph declares no type for the island input', () => {
    const patch = patchNormalisationIslands(fakeModel(ISLAND, []));

    expect(patch.changed).toBe(false);
    expect(patch.skipped.map((island) => island.reason)).toEqual([
      'the graph declares no type for x',
    ]);
  });

  it('returns the model untouched when it holds no island', () => {
    const model = fakeModel([
      { name: '/a', opType: 'Cast', inputs: ['mix'], outputs: ['x'] },
      { name: '/b', opType: 'Relu', inputs: ['x'], outputs: ['y'] },
    ]);
    const patch = patchNormalisationIslands(model);

    expect(patch.changed).toBe(false);
    expect(patch.bytes).toBe(model);
    expect(patch.islands).toEqual([]);
  });

  it('does not touch the bytes it was given', () => {
    const model = fakeModel();
    const copy = Uint8Array.from(model);
    patchNormalisationIslands(model);

    expect([...model]).toEqual([...copy]);
  });

  it('picks a suffix the graph is not already using', () => {
    const taken = ISLAND.map((node) => ({
      ...node,
      outputs: (node.outputs ?? []).map((name) => name),
    }));
    const nodes = [
      ...taken,
      { name: '/squatter', opType: 'Relu', inputs: ['y'], outputs: ['x_kara_fp32'] },
    ];
    const patch = patchNormalisationIslands(fakeModel(nodes));

    expect(patch.suffix).not.toBe('_kara_fp32');
    expect(summariseGraph(patch.bytes).nodes.some((node) => node.outputs.includes('x_kara_fp32'))).toBe(
      true,
    );
  });
});
