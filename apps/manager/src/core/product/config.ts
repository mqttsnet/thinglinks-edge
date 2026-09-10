import { PRODUCT_DEFAULTS as defaults } from './defaults.ts';

export const GITHUB_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/;
export interface ProductConfig {
  name: string;
  tagline: string;
  description: string;
  logoUrl: string;
  copyrightStartYear: number;
  copyrightOwner: string;
  communityName: string;
  communityUrl: string;
  githubRepository: string;
  repositoryUrl: string;
  releasesUrl: string;
  issuesUrl: string;
  docsUrl: string;
  license: string;
  releasesEnabled: boolean;
}

/** Public metadata is an explicit allowlist; credentials and arbitrary environment keys never leave here. */
export function loadProductConfig(env: NodeJS.ProcessEnv = process.env): ProductConfig {
  const text = (key: string, fallback: string, limit = 160) => {
    const value = (env[key] ?? fallback).trim();
    if (value.length > limit) throw new Error(`${key} 超过长度上限`);
    return value;
  };
  const url = (key: string, fallback: string, asset = false) => {
    const value = text(key, fallback, 2048);
    if (!value) return '';
    if (asset && /^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(value) && !value.split('/').includes('..')) return value;
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
      return parsed.href;
    } catch { throw new Error(`${key} 需要有效的 HTTP(S) 地址${asset ? '或相对资源路径' : ''}`); }
  };
  const githubRepository = text('PRODUCT_GITHUB_REPOSITORY', defaults.githubRepository);
  if (githubRepository && !GITHUB_REPOSITORY.test(githubRepository)) throw new Error('PRODUCT_GITHUB_REPOSITORY 需要 owner/repository 格式');
  const year = Number(env['PRODUCT_COPYRIGHT_START_YEAR'] ?? defaults.copyrightStartYear);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) throw new Error('PRODUCT_COPYRIGHT_START_YEAR 需要有效年份');
  const enabled = text('PRODUCT_RELEASES_ENABLED', 'true');
  if (!['true', 'false'].includes(enabled)) throw new Error('PRODUCT_RELEASES_ENABLED 仅支持 true 或 false');
  const repositoryUrl = githubRepository ? `https://github.com/${githubRepository}` : '';
  return {
    name: text('PRODUCT_NAME', defaults.name) || defaults.name,
    tagline: text('PRODUCT_TAGLINE', defaults.tagline),
    description: text('PRODUCT_DESCRIPTION', defaults.description, 1000),
    logoUrl: url('PRODUCT_LOGO_URL', defaults.logoUrl, true),
    copyrightStartYear: year,
    copyrightOwner: text('PRODUCT_COPYRIGHT_OWNER', defaults.copyrightOwner),
    communityName: text('PRODUCT_COMMUNITY_NAME', defaults.communityName),
    communityUrl: url('PRODUCT_COMMUNITY_URL', defaults.communityUrl),
    githubRepository, repositoryUrl,
    releasesUrl: repositoryUrl ? `${repositoryUrl}/releases` : '',
    issuesUrl: repositoryUrl ? `${repositoryUrl}/issues` : '',
    docsUrl: env['PRODUCT_DOCS_URL']?.trim() === 'auto' || env['PRODUCT_DOCS_URL'] === undefined
      ? (repositoryUrl ? `${repositoryUrl}#readme` : '') : url('PRODUCT_DOCS_URL', ''),
    license: text('PRODUCT_LICENSE', defaults.license),
    releasesEnabled: enabled === 'true' && githubRepository !== '',
  };
}
