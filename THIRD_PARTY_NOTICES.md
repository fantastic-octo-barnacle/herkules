# Third-party materials

The project's dual MIT/Apache-2.0 license covers original Herkules contributions.
Third-party materials retain their own licenses and attribution requirements.

- `services/web/public/hero.webp`: photograph by John Cobb, cropped, desaturated
  and converted to WebP. [Original photograph](https://unsplash.com/photos/6btEyS3AJrI),
  [Unsplash License](https://unsplash.com/license).
- The AI build downloads a checksum-pinned New API source archive and applies
  local changes. Preserve the upstream license and notices in that source archive;
  the root dual license does not replace them. The modified source is distributed
  as `portal-source.tar.gz`; see [the build documentation](tools/ai/new-api/README.md).
- Dependencies and container base images retain their own licenses. Their resolved
  versions are recorded in `pnpm-lock.yaml`, the Dockerfile and the portal build.

Live BBS corpus data and user uploads are not included in this source-code license.
