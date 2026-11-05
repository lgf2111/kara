/**
 * The one door between this extension and the separation engine the web app
 * already has.
 *
 * None of the hard parts are rewritten here. The windowing, the crossfade, the
 * tiling guarantee, the float32 island patch WebGPU needs and the backend
 * policy all live in `apps/web/src/separation`, are tested there, and are
 * imported across the workspace by relative path rather than copied. What the
 * extension adds is a fetch of the video's own audio at one end and a
 * whole-track player at the other.
 *
 * Everything heavy the extension uses passes through this file, so the
 * dependency is one import away from being read, moved or measured. It is also
 * the reason this file is imported by the separation worker and by nothing
 * else: `segment-runner.ts` pulls in onnxruntime-web, which has no business in
 * the offscreen document's own bundle. The model's constants, which everything
 * needs, are in `model.ts` for that reason.
 */

export { probeGpu } from '../../../web/src/separation/backend-choice.ts';
export { decideBackend } from '../../../web/src/separation/backend-policy.ts';
export { createSegmentRunner } from '../../../web/src/separation/segment-runner.ts';
export { createStreamingSeparator } from '../../../web/src/separation/streaming.ts';

export type { Backend } from '../../../web/src/separation/protocol.ts';
export type { SegmentRunner } from '../../../web/src/separation/segment-contract.ts';
export type { StreamBlock, StreamingSeparator } from '../../../web/src/separation/streaming.ts';
