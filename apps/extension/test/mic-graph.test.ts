import { describe, expect, it } from 'vitest';

import { DEFAULT_MIC_FX, type MicFx } from '../src/audio/mic-fx.ts';
import { createMicGraph, reverbImpulse } from '../src/audio/mic-graph.ts';

interface FakeParam {
  value: number;
  readonly targets: { readonly value: number; readonly at: number }[];
  setTargetAtTime: (value: number, at: number) => void;
}

interface FakeNode {
  readonly kind: string;
  readonly id: number;
  gain: FakeParam;
  frequency: FakeParam;
  Q: FakeParam;
  threshold: FakeParam;
  knee: FakeParam;
  ratio: FakeParam;
  attack: FakeParam;
  release: FakeParam;
  delayTime: FakeParam;
  type: string;
  buffer: AudioBuffer | null;
  connect: (to: FakeNode) => FakeNode;
  disconnect: () => void;
  disconnected: boolean;
}

function param(value = 0): FakeParam {
  const targets: { readonly value: number; readonly at: number }[] = [];
  return {
    value,
    targets,
    setTargetAtTime(next: number, at: number) {
      this.value = next;
      targets.push({ value: next, at });
    },
  };
}

function fakeNode(kind: string, id: number): FakeNode {
  const node: FakeNode = {
    kind,
    id,
    gain: param(),
    frequency: param(),
    Q: param(),
    threshold: param(),
    knee: param(),
    ratio: param(),
    attack: param(),
    release: param(),
    delayTime: param(),
    type: '',
    buffer: null,
    disconnected: false,
    connect(to: FakeNode) {
      connections.push({ from: node, to });
      return to;
    },
    disconnect() {
      node.disconnected = true;
    },
  };
  return node;
}

let connections: { readonly from: FakeNode; readonly to: FakeNode }[] = [];

function fakeContext(): { context: AudioContext; created: FakeNode[] } {
  const created: FakeNode[] = [];
  let nextId = 0;
  const make = (kind: string): FakeNode => {
    const node = fakeNode(kind, nextId);
    nextId += 1;
    created.push(node);
    return node;
  };
  const context = {
    sampleRate: 48_000,
    currentTime: 0,
    createGain: () => make('gain'),
    createBiquadFilter: () => make('biquad'),
    createDynamicsCompressor: () => make('compressor'),
    createConvolver: () => make('convolver'),
    createDelay: () => make('delay'),
    createBuffer: (channels: number, length: number, rate: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate: rate,
        getChannelData: (channel: number) => data[channel] as Float32Array,
      } as unknown as AudioBuffer;
    },
  };
  return { context: context as unknown as AudioContext, created };
}

const full: MicFx = {
  level: 1,
  monitor: true,
  reverb: 1,
  echo: 1,
  tone: 1,
  compression: 1,
};

describe('createMicGraph', () => {
  it('builds the dry, reverb and echo paths with separate monitor and record outputs', () => {
    connections = [];
    const { context, created } = fakeContext();
    const monitor = fakeNode('monitor', 1000);
    const record = fakeNode('record', 1001);

    createMicGraph(context, monitor as unknown as AudioNode, record as unknown as AudioNode);

    expect(created.filter((node) => node.kind === 'convolver')).toHaveLength(1);
    expect(created.filter((node) => node.kind === 'delay')).toHaveLength(1);
    expect(connections.some((link) => link.to === monitor)).toBe(true);
    expect(connections.some((link) => link.to === record)).toBe(true);
    // The echo is a loop: delay → feedback → delay.
    const delay = created.find((node) => node.kind === 'delay');
    expect(delay).toBeDefined();
    expect(
      connections.some((link) => link.from === delay && link.to.kind === 'gain'),
    ).toBe(true);
    expect(
      connections.some((link) => link.to === delay && link.from.kind === 'gain'),
    ).toBe(true);
  });

  it('keeps the monitor shut by default and opens it with the switch', () => {
    connections = [];
    const { context } = fakeContext();
    const monitor = fakeNode('monitor', 1000);
    const record = fakeNode('record', 1001);
    const graph = createMicGraph(
      context,
      monitor as unknown as AudioNode,
      record as unknown as AudioNode,
    );
    const monitorGain = connections.find((link) => link.to === monitor)?.from;

    expect(monitorGain?.gain.value).toBe(0);
    graph.apply(full, 0);
    expect(monitorGain?.gain.value).toBe(1);
    graph.apply(DEFAULT_MIC_FX, 0);
    expect(monitorGain?.gain.value).toBe(0);
  });

  it('maps the desk onto the compressor, tone and effect sends', () => {
    connections = [];
    const { context, created } = fakeContext();
    const graph = createMicGraph(
      context,
      fakeNode('monitor', 1000) as unknown as AudioNode,
      fakeNode('record', 1001) as unknown as AudioNode,
    );
    graph.apply(full, 0.5);

    const filters = created.filter((node) => node.kind === 'biquad');
    const highpass = filters[0];
    const tone = filters[1];
    const compressor = created.find((node) => node.kind === 'compressor');
    const convolver = created.find((node) => node.kind === 'convolver');
    const delay = created.find((node) => node.kind === 'delay');
    const reverbWet = connections.find((link) => link.from === convolver)?.to;
    const feedback = connections.find(
      (link) => link.from === delay && linksBack(link.to, delay),
    )?.to;

    expect(highpass?.frequency.value).toBe(90);
    expect(tone?.frequency.value).toBe(3200);
    expect(tone?.gain.value).toBeCloseTo(6);
    expect(compressor?.threshold.value).toBeCloseTo(-36);
    expect(compressor?.ratio.value).toBeCloseTo(8);
    expect(convolver?.buffer).not.toBeNull();
    expect(reverbWet?.gain.value).toBeCloseTo(0.8);
    expect(delay?.delayTime.value).toBeCloseTo(0.4);
    expect(feedback?.gain.value).toBeCloseTo(0.55);
  });

  it('removes every node it built', () => {
    connections = [];
    const { context, created } = fakeContext();
    const graph = createMicGraph(
      context,
      fakeNode('monitor', 1000) as unknown as AudioNode,
      fakeNode('record', 1001) as unknown as AudioNode,
    );

    graph.disconnect();

    expect(created.every((node) => node.disconnected)).toBe(true);
  });
});

function linksBack(node: FakeNode, to: FakeNode): boolean {
  return connections.some((link) => link.from === node && link.to === to);
}

describe('reverbImpulse', () => {
  it('is stereo, finite and quietens towards its end', () => {
    const { context } = fakeContext();
    const buffer = reverbImpulse(context);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const first = left.slice(0, 200).reduce((sum, sample) => sum + Math.abs(sample), 0);
    const last = left.slice(-200).reduce((sum, sample) => sum + Math.abs(sample), 0);

    expect(buffer.numberOfChannels).toBe(2);
    expect(left).toHaveLength(Math.round(48_000 * 2.4));
    expect(left.every((sample) => Number.isFinite(sample))).toBe(true);
    expect(right.some((sample) => sample !== 0)).toBe(true);
    expect(last).toBeLessThan(first);
  });
});
