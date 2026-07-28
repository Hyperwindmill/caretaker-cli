/** Decide whether to (re)focus the composer textarea.
 *
 *  Focus only on a disabled -> enabled transition, and only when the webview
 *  document already holds focus. The `documentHasFocus` guard means we RESTORE
 *  focus (after a turn finishes, a confirmation resolves, or an agent is selected)
 *  without STEALING it from the editor or another window — this is what keeps the
 *  VSCode sidebar from yanking the caret out of the code editor. It is
 *  surface-agnostic: no `layout` gate needed.
 *
 *  Initial mount is modelled as a transition from "disabled" by seeding the caller's
 *  previous-disabled tracker to `true`, so a composer that mounts already enabled
 *  (web/desktop on load) autofocuses, guarded the same way. */
export function shouldFocusComposer(
  prevDisabled: boolean,
  disabled: boolean,
  documentHasFocus: boolean,
): boolean {
  return prevDisabled && !disabled && documentHasFocus;
}