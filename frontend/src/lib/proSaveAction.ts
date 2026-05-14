/**
 * Pro save-action registry.
 *
 * EditorPage used to import useAuthStore + SaveProjectModal + LoginPromptModal
 * directly, branching on `user` to decide which modal to open when the
 * user pressed Save. After Phase 3 of the OSS split, all of those live
 * in the pro overlay. The OSS editor exposes a stable `triggerSaveAction()`
 * that:
 *
 *   - In OSS without an overlay → no-op (in Phase 4 this becomes the
 *     entry point for the .vlx Export dialog so anonymous users still
 *     have a way to persist work).
 *   - With the pro overlay loaded → dispatches to the registered impl,
 *     which inspects the auth store and opens SaveProjectModal (logged
 *     in) or LoginPromptModal (anonymous).
 *
 * Impl receives no arguments and returns nothing. State lives in the
 * overlay's React tree (modal open/close, project data) — this registry
 * is just the doorbell.
 */

let _impl: (() => void) | null = null;

export function installSaveActionImpl(impl: (() => void) | null): void {
  _impl = impl;
}

export function triggerSaveAction(): void {
  if (_impl) {
    try {
      _impl();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[oss] save-action impl threw:', err);
    }
  } else {
    // eslint-disable-next-line no-console
    console.info(
      '[oss] No save handler is installed. Builds without the pro overlay ' +
        'will gain a local .vlx export in Phase 4 of the OSS split.',
    );
  }
}

/** Whether an implementation has been installed. Lets UI conditionally
 * show the Save button — without an impl, clicking it does nothing useful. */
export function hasSaveActionImpl(): boolean {
  return _impl !== null;
}
