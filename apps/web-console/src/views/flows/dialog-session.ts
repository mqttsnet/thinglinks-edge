/** Each opening owns its modal callbacks; an old leave/close event cannot affect the next template. */
export function createDialogSessions(updateVisible: (show: boolean) => void) {
  let generation = 0;
  return {
    open() {
      const id = ++generation;
      return { id, onUpdateShow: (show: boolean) => { if (id === generation) updateVisible(show); } };
    },
  };
}
