import type { Router } from 'vue-router';
import type { Instance } from '../../api/types.ts';

/** Native links open the existing password-entry route before any asynchronous authentication. */
export function editorEntryProps(router: Pick<Router, 'resolve'>, instance: Pick<Instance, 'id' | 'running'>) {
  return {
    tag: 'a' as const,
    href: instance.running ? router.resolve({ name: 'instances', query: { editor: instance.id } }).href : undefined,
    target: '_blank',
    rel: 'noopener noreferrer',
    title: '在新标签页打开编辑器',
    disabled: !instance.running,
  };
}
