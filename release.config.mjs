// semantic-release (the release job in .github/workflows/ci.yml): each push to main that
// changes the version tags it v<version> and creates a GitHub Release, and the TestFlight
// workflow uploads the iPhone/iPad and Apple TV apps at that version.
export default {
  branches: ['main'],
  tagFormat: 'v${version}',
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    ['@semantic-release/github', { successComment: false, failComment: false }],
    [
      '@semantic-release/exec',
      { prepareCmd: 'if [ -n "$GITHUB_OUTPUT" ]; then echo "version=${nextRelease.version}" >> "$GITHUB_OUTPUT"; fi' },
    ],
  ],
};
