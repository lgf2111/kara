/**
 * Rewrites a normalisation island to compute in float32.
 *
 * The island is htdemucs' input normalisation, which torch exports as eight
 * nodes:
 *
 *     mean     = ReduceMean(x, axes=A, keepdims=1)
 *     diff     = Sub(x, mean)
 *     square   = Pow(diff, 2)
 *     variance = ReduceMean(square, axes=A, keepdims=1)
 *     clipped  = Clip(variance, 0)            // optional
 *     std      = Sqrt(clipped)
 *     denom    = Add(std, eps)
 *     result   = Div(diff, denom)
 *
 * In `htdemucs-web` every tensor on that path is float16, and `variance` is
 * the mean of a few million non-negative squares. Summing those in half
 * precision is the one step of the island with no headroom: the running total
 * leaves fp16's integer range long before the reduction ends. WebGPU's
 * reduction collapses to zero there, `std` follows, and `Div` then divides by
 * the bare epsilon, which is where the +-65000 comes from.
 *
 * The rewrite is local. One Cast puts `x` into float32, the eight nodes are
 * rebuilt on float32 tensors under new names, and every island tensor that
 * something outside the island reads is cast back to the type the graph
 * declared for it. Nothing outside the island changes name or type, so the
 * piece's inputs and outputs are the same contract as before and the fp16
 * rounding of the reference is reproduced rather than improved on.
 *
 * Attributes are copied as bytes, so `axes` keeps whatever encoding the
 * exporter chose and an opset that passes axes as an input is carried through
 * untouched: only the inputs a float32 rebuild must convert are rewritten.
 *
 * This is what lets separation run on WebGPU: segment-runner.ts applies it to
 * every piece before creating a WebGPU session, for the file pipeline and for
 * live capture alike. The diagnostics page imports the same function, so the
 * measured patch and the shipped patch are one.
 */

import {
  FLOAT32,
  concat,
  encodeCast,
  encodeNode,
  rewriteGraph,
  summariseGraph,
  usedNames,
  valueInfoName,
  GRAPH_NODE,
  GRAPH_VALUE_INFO,
  type GraphNode,
  type GraphSummary,
} from './onnx-graph.ts';

export const ISLAND_ROLES = [
  'mean',
  'diff',
  'square',
  'variance',
  'clip',
  'std',
  'denom',
  'result',
] as const;

export type IslandRole = (typeof ISLAND_ROLES)[number];

export interface IslandStep {
  readonly role: IslandRole;
  readonly nodeIndex: number;
  readonly nodeName: string;
  readonly opType: string;
  /** The step's first output, which is the tensor the role is named for. */
  readonly output: string;
}

export interface Island {
  /** The tensor the island normalises, and the one Cast's input. */
  readonly input: string;
  /** The elem_type the graph declares for `input`, or null if it declares none. */
  readonly inputElemType: number | null;
  /** Both reductions', which the match requires to agree. */
  readonly axes: readonly number[];
  readonly keepDims: number | null;
  /** In stored node order, which is the order the rewrite emits them in. */
  readonly steps: readonly IslandStep[];
}

/**
 * Which inputs of each island op carry a value that has to become float32.
 *
 * Explicit rather than "all of them" on purpose: ReduceMean takes `axes` as an
 * int64 input from opset 18, and Clip's unused bound is the empty name. Both
 * have to pass through as they are.
 */
const FP32_INPUTS: Readonly<Record<string, readonly number[]>> = {
  ReduceMean: [0],
  Sub: [0, 1],
  Pow: [0, 1],
  Clip: [0, 1, 2],
  Sqrt: [0],
  Add: [0, 1],
  Div: [0, 1],
};

interface GraphIndex {
  readonly producer: ReadonlyMap<string, GraphNode>;
  readonly consumers: ReadonlyMap<string, readonly GraphNode[]>;
  readonly graphOutputs: ReadonlySet<string>;
}

function indexGraph(summary: GraphSummary): GraphIndex {
  const producer = new Map<string, GraphNode>();
  const consumers = new Map<string, GraphNode[]>();
  for (const node of summary.nodes) {
    for (const output of node.outputs) {
      if (output !== '') {
        producer.set(output, node);
      }
    }
    for (const input of node.inputs) {
      if (input === '') {
        continue;
      }
      const list = consumers.get(input);
      if (list === undefined) {
        consumers.set(input, [node]);
      } else {
        list.push(node);
      }
    }
  }
  return { producer, consumers, graphOutputs: new Set(summary.outputs) };
}

/**
 * The one consumer of `tensor` with this op type, or null.
 *
 * One of a type rather than one consumer at all: `std` feeds both the Add that
 * finishes the island and an Unsqueeze that reports it, and that fan-out is
 * normal. Ambiguity is still refused, so two Adds reading the same std leave
 * the island unmatched rather than half-rewritten.
 */
function lone(index: GraphIndex, tensor: string, opType: string): GraphNode | null {
  const matching = (index.consumers.get(tensor) ?? []).filter((node) => node.opType === opType);
  return matching.length === 1 ? (matching[0] ?? null) : null;
}

function firstOutput(node: GraphNode): string | null {
  const output = node.outputs[0];
  return output === undefined || output === '' ? null : output;
}

function intAttribute(node: GraphNode, name: string): number | null {
  return node.attributes.find((attribute) => attribute.name === name)?.int ?? null;
}

function intsAttribute(node: GraphNode, name: string): readonly number[] {
  return node.attributes.find((attribute) => attribute.name === name)?.ints ?? [];
}

function step(role: IslandRole, node: GraphNode): IslandStep {
  return {
    role,
    nodeIndex: node.index,
    nodeName: node.name,
    opType: node.opType,
    output: firstOutput(node) ?? '',
  };
}

/**
 * Every normalisation island in the graph, in stored node order.
 *
 * Matched through the data flow rather than by node index or name, so the same
 * pattern is found wherever it sits and however the exporter named it.
 */
export function findNormalisationIslands(summary: GraphSummary): readonly Island[] {
  const index = indexGraph(summary);
  const claimed = new Set<number>();
  const islands: Island[] = [];

  for (const square of summary.nodes) {
    if (square.opType !== 'Pow') {
      continue;
    }
    const diffName = square.inputs[0];
    const squareOut = firstOutput(square);
    if (diffName === undefined || diffName === '' || squareOut === null) {
      continue;
    }
    const diff = index.producer.get(diffName);
    if (diff === undefined || diff.opType !== 'Sub') {
      continue;
    }
    const input = diff.inputs[0];
    const meanName = diff.inputs[1];
    if (input === undefined || input === '' || meanName === undefined || meanName === '') {
      continue;
    }
    const mean = index.producer.get(meanName);
    if (mean === undefined || mean.opType !== 'ReduceMean' || mean.inputs[0] !== input) {
      continue;
    }

    const variance = lone(index, squareOut, 'ReduceMean');
    const varianceOut = variance === null ? null : firstOutput(variance);
    if (variance === null || varianceOut === null || variance.inputs[0] !== squareOut) {
      continue;
    }
    const clip = lone(index, varianceOut, 'Clip');
    const beforeSqrt = clip ?? variance;
    const beforeSqrtOut = firstOutput(beforeSqrt);
    if (beforeSqrtOut === null) {
      continue;
    }
    const std = lone(index, beforeSqrtOut, 'Sqrt');
    const stdOut = std === null ? null : firstOutput(std);
    if (std === null || stdOut === null) {
      continue;
    }
    const denom = lone(index, stdOut, 'Add');
    const denomOut = denom === null ? null : firstOutput(denom);
    if (denom === null || denomOut === null) {
      continue;
    }
    const result = lone(index, denomOut, 'Div');
    if (result === null || result.inputs[0] !== diffName || result.inputs[1] !== denomOut) {
      continue;
    }

    // Both reductions have to be the same reduction, or this is some other
    // arrangement of the same op types and not a normalisation.
    const axes = intsAttribute(mean, 'axes');
    if (axes.join(',') !== intsAttribute(variance, 'axes').join(',')) {
      continue;
    }
    if (intAttribute(mean, 'keepdims') !== intAttribute(variance, 'keepdims')) {
      continue;
    }

    const steps = [
      step('mean', mean),
      step('diff', diff),
      step('square', square),
      step('variance', variance),
      ...(clip === null ? [] : [step('clip', clip)]),
      step('std', std),
      step('denom', denom),
      step('result', result),
    ].sort((left, right) => left.nodeIndex - right.nodeIndex);

    if (steps.some((item) => claimed.has(item.nodeIndex) || item.output === '')) {
      continue;
    }
    for (const item of steps) {
      claimed.add(item.nodeIndex);
    }
    islands.push({
      input,
      inputElemType: summary.declaredTypes.get(input) ?? null,
      axes,
      keepDims: intAttribute(mean, 'keepdims'),
      steps,
    });
  }

  return islands.sort(
    (left, right) => (left.steps[0]?.nodeIndex ?? 0) - (right.steps[0]?.nodeIndex ?? 0),
  );
}

export interface PatchedIsland extends Island {
  /** Original tensor name to its float32 twin, for pairing a probe up again. */
  readonly renames: Readonly<Record<string, string>>;
  /** Island tensors something outside reads, so they are cast back. */
  readonly boundary: readonly { readonly tensor: string; readonly elemType: number }[];
  /** Island tensors nothing outside reads, so they lose their value_info. */
  readonly internal: readonly string[];
}

export interface SkippedIsland extends Island {
  readonly reason: string;
}

export interface IslandPatch {
  readonly bytes: Uint8Array;
  readonly islands: readonly PatchedIsland[];
  readonly skipped: readonly SkippedIsland[];
  readonly changed: boolean;
  /** Appended to every rewritten tensor and node name. */
  readonly suffix: string;
}

export interface PatchOptions {
  readonly suffix?: string;
}

/** A suffix no `name + suffix` of any island name collides with. */
function freeSuffix(taken: ReadonlySet<string>, wanted: readonly string[], base: string): string {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const suffix = attempt === 0 ? base : `${base}${String(attempt)}`;
    if (wanted.every((name) => !taken.has(`${name}${suffix}`))) {
      return suffix;
    }
  }
  throw new Error('no free suffix for the float32 rewrite');
}

/**
 * The same model with every float16 normalisation island computed in float32.
 *
 * Pure: the model bytes go in, new bytes come out, and the original is left
 * alone. When no island matches, or every match is already float32, the input
 * is returned as it is and `changed` is false.
 */
export function patchNormalisationIslands(
  model: Uint8Array,
  options: PatchOptions = {},
): IslandPatch {
  const summary = summariseGraph(model);
  const index = indexGraph(summary);
  const found = findNormalisationIslands(summary);

  const patchable: Island[] = [];
  const skipped: SkippedIsland[] = [];
  for (const island of found) {
    if (island.inputElemType === null) {
      skipped.push({ ...island, reason: `the graph declares no type for ${island.input}` });
    } else if (island.inputElemType === FLOAT32) {
      skipped.push({ ...island, reason: 'already float32' });
    } else {
      patchable.push(island);
    }
  }

  const suffixBase = options.suffix ?? '_kara_fp32';
  if (patchable.length === 0) {
    return { bytes: model, islands: [], skipped, changed: false, suffix: suffixBase };
  }

  const nodesByIndex = new Map(summary.nodes.map((node) => [node.index, node]));
  /** Every tensor the islands produce, mapped to the name it gets in float32. */
  const twins = new Map<string, string>();
  const wanted = new Set<string>();
  for (const island of patchable) {
    wanted.add(island.input);
    for (const item of island.steps) {
      wanted.add(item.output);
      const node = nodesByIndex.get(item.nodeIndex);
      for (const name of node?.inputs ?? []) {
        if (name !== '') {
          wanted.add(name);
        }
      }
    }
  }
  const suffix = freeSuffix(usedNames(summary), [...wanted], suffixBase);
  for (const island of patchable) {
    for (const item of island.steps) {
      twins.set(item.output, `${item.output}${suffix}`);
    }
  }

  /** Cast-to-float32 nodes, emitted once at the first island node that needs one. */
  const converted = new Map<string, string>();
  const emission = new Map<number, Uint8Array[]>();
  const internalNames = new Set<string>();

  const parts = patchable.map((island) => ({
    island,
    own: new Set(island.steps.map((item) => item.nodeIndex)),
    renames: {} as Record<string, string>,
    boundary: [] as { tensor: string; elemType: number }[],
    internal: [] as string[],
  }));

  // Every island's steps together, in stored node order. One pass in that
  // order is what keeps a shared Cast, the exponent two for instance, in front
  // of the first node that reads it even when two islands interleave.
  const ordered = parts
    .flatMap((part) => part.island.steps.map((item) => ({ part, item })))
    .sort((left, right) => left.item.nodeIndex - right.item.nodeIndex);

  for (const { part, item } of ordered) {
    const node = nodesByIndex.get(item.nodeIndex);
    if (node === undefined) {
      throw new Error(`island step ${item.nodeName} has no node`);
    }
    const before: Uint8Array[] = [];
    const after: Uint8Array[] = [];

    const toFloat32 = (name: string): string => {
      const existing = converted.get(name);
      if (existing !== undefined) {
        return existing;
      }
      const target = `${name}${suffix}`;
      before.push(encodeCast(`${target}_cast`, name, target, FLOAT32));
      converted.set(name, target);
      return target;
    };

    const fp32Inputs = FP32_INPUTS[node.opType] ?? [];
    const inputs = node.inputs.map((name, at) => {
      if (name === '' || !fp32Inputs.includes(at)) {
        return name;
      }
      return twins.get(name) ?? toFloat32(name);
    });
    const outputs = node.outputs.map((name) => (name === '' ? '' : `${name}${suffix}`));

    for (const name of node.outputs) {
      if (name === '') {
        continue;
      }
      part.renames[name] = `${name}${suffix}`;
      const readOutside =
        index.graphOutputs.has(name) ||
        (index.consumers.get(name) ?? []).some((consumer) => !part.own.has(consumer.index));
      if (readOutside) {
        const elemType =
          summary.declaredTypes.get(name) ?? part.island.inputElemType ?? FLOAT32;
        part.boundary.push({ tensor: name, elemType });
        after.push(encodeCast(`${name}${suffix}_back`, `${name}${suffix}`, name, elemType));
      } else {
        part.internal.push(name);
        internalNames.add(name);
      }
    }

    // An exporter may leave a node unnamed; two of those would then collide on
    // the suffix alone, so the name falls back to the output it produces.
    const base = node.name === '' ? `${outputs[0] ?? item.output}_node` : `${node.name}${suffix}`;
    emission.set(item.nodeIndex, [
      ...before,
      encodeNode({
        name: base,
        opType: node.opType,
        inputs,
        outputs,
        attributes: node.attributes.map((attribute) => attribute.raw),
      }),
      ...after,
    ]);
  }

  const patched: PatchedIsland[] = parts.map((part) => ({
    ...part.island,
    renames: part.renames,
    boundary: part.boundary,
    internal: part.internal,
  }));

  const bytes = rewriteGraph(model, (field, ordinal) => {
    if (field.field === GRAPH_NODE) {
      const replacement = emission.get(ordinal);
      return replacement === undefined ? undefined : concat(replacement);
    }
    // A tensor no node produces any more must not stay declared.
    if (field.field === GRAPH_VALUE_INFO && internalNames.has(valueInfoName(model, field))) {
      return null;
    }
    return undefined;
  });

  return { bytes, islands: patched, skipped, changed: true, suffix };
}
