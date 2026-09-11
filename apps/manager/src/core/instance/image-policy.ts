/** Keep the newest supported image first; existing versions remain available for rollback. */
const DEFAULT_NODE_RED_IMAGE_TAGS = [
  '5.0.7-24-minimal', '5.0.4-24-minimal', '4.1.13-22-minimal',
] as const;

/** An explicit allowlist replaces the defaults, including an intentionally empty list. */
export function allowedNodeRedImageTags(configured?: string): string[] {
  if (configured === undefined) return [...DEFAULT_NODE_RED_IMAGE_TAGS];
  return [...new Set(configured.split(',').map(tag => tag.trim()).filter(Boolean))];
}
