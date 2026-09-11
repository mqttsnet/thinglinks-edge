import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDialogSessions } from './dialog-session.ts';

test('late close callbacks from a departing modal cannot close the newly opened template', () => {
  let visible = true;
  const sessions = createDialogSessions(show => { visible = show; });
  const previous = sessions.open();
  previous.onUpdateShow(false);
  assert.equal(visible, false);
  const current = sessions.open(); visible = true;
  assert.notEqual(current.id, previous.id);
  previous.onUpdateShow(false);
  assert.equal(visible, true);
  current.onUpdateShow(false);
  assert.equal(visible, false);
});
