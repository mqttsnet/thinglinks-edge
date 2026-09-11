export interface ProductMetadata {
  name: string; tagline: string; description: string; logoUrl: string;
  copyrightStartYear: number; copyrightOwner: string;
  communityName: string; communityUrl: string; githubRepository: string;
  repositoryUrl: string; releasesUrl: string; issuesUrl: string; docsUrl: string;
  license: string; releasesEnabled: boolean;
}
export interface ProductRelease {
  tag: string; name: string; body: string; publishedAt: string; url: string;
  prerelease: boolean; truncated: boolean;
}
export interface ProductReleaseResult {
  state: 'ready' | 'error' | 'disabled'; releases: ProductRelease[];
  checkedAt: string; message?: string;
}
