import { setupManifest } from '@start9labs/start-sdk'
import { long, short } from './i18n'

export const manifest = setupManifest({
  id: 'pactd',
  title: 'Pact',
  license: 'Apache-2.0',
  packageRepo: 'https://github.com/bobodread876/pact',
  upstreamRepo: 'https://github.com/bobodread876/pact',
  marketingUrl: 'https://github.com/bobodread876/pact',
  donationUrl: null,
  description: { short, long },
  volumes: ['main'],
  images: {
    pactd: {
      source: { dockerTag: 'ghcr.io/bobodread876/pactd:0.11.0' },
      arch: ['x86_64', 'aarch64'],
    },
  },
  alerts: {
    install: null,
    update: null,
    uninstall: null,
    restore: null,
    start: null,
    stop: null,
  },
  dependencies: {},
})
