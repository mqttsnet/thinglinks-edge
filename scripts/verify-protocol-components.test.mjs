import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVerificationState } from './verify-protocol-components.mjs';

test('cleanup requires an explicit task label and captured immutable resource ids', () => {
  const state={label:'pt3-00000000-0000-4000-8000-000000000001',containers:['a'.repeat(64)],network:'b'.repeat(64)};
  assert.doesNotThrow(()=>validateVerificationState(state));
  for(const bad of [{...state,label:undefined},{...state,label:'production'},{...state,containers:['line-1']},
    {...state,network:'thinglinks-edge'},{...state,containers:undefined},{...state,accessNetwork:'bridge'},
    {...state,beforeIds:['--format']},{...state,containers:[state.containers[0],state.containers[0]]}]) {
    assert.throws(()=>validateVerificationState(bad));
  }
});
