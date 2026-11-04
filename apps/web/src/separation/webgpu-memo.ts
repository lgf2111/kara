/**
 * One note, kept for the rest of the browsing session: WebGPU produced
 * garbage here, so stop asking it.
 *
 * Without this, a machine whose driver miscompiles the graph would pay for a
 * failed WebGPU attempt again on every song in the queue. It is deliberately
 * not persisted beyond the session: a browser or driver update is exactly the
 * kind of thing that makes WebGPU worth trying again, and closing the tab is
 * the cheapest way for a person to ask for that.
 *
 * `sessionStorage` is the store, so a reload inside the same tab keeps the
 * note, with a copy in this module for a context that has no such storage.
 */

const KEY = 'kara.separation.webgpuBlocked';

let remembered: string | null = null;

/** Typed structurally so this module needs no DOM types to be read in a test. */
interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function store(): SessionStore | null {
  try {
    return (globalThis as unknown as { sessionStorage?: SessionStore }).sessionStorage ?? null;
  } catch {
    // A browser that blocks storage throws on the property itself.
    return null;
  }
}

/** Why WebGPU was set aside, or null if it has not been. */
export function webgpuBlockedReason(): string | null {
  if (remembered !== null) {
    return remembered;
  }
  try {
    remembered = store()?.getItem(KEY) ?? null;
  } catch {
    remembered = null;
  }
  return remembered;
}

export function blockWebgpu(reason: string): void {
  remembered = reason;
  try {
    store()?.setItem(KEY, reason);
  } catch {
    // The copy in this module is enough for this page.
  }
}
