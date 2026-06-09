import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.11.0:0',
  releaseNotes: {
    en_US: 'Initial StartOS release of Pact (pactd 0.11.0).',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
