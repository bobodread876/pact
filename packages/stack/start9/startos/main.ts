import { i18n } from './i18n'
import { sdk } from './sdk'
import { uiPort } from './utils'

export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting Pact daemon…'))

  return sdk.Daemons.of(effects).addDaemon('primary', {
    subcontainer: await sdk.SubContainer.of(
      effects,
      { imageId: 'pactd' },
      sdk.Mounts.of().mountVolume({
        volumeId: 'main',
        subpath: null,
        mountpoint: '/data',
        readonly: false,
      }),
      'pactd-sub',
    ),
    exec: {
      command: ['node', 'packages/pactd/dist/index.js'],
      cwd: '/app',
      env: {
        PACT_HOST: '0.0.0.0',
        PACT_PORT: String(uiPort),
        PACT_HOME: '/data/.pact',
        // No app-seed on StartOS to derive a secret from — pactd generates and
        // persists its own bearer token; it's shown in the Pact UI.
        PACT_AUTO_TOKEN: 'true',
      },
    },
    ready: {
      display: i18n('Web Interface'),
      fn: () =>
        sdk.healthCheck.checkPortListening(effects, uiPort, {
          successMessage: i18n('The Pact daemon is ready'),
          errorMessage: i18n('The Pact daemon is not ready'),
        }),
    },
    requires: [],
  })
})
