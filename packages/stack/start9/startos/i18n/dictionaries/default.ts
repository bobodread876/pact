export const DEFAULT_LANG = 'en_US'

const dict = {
  // main.ts
  'Starting Pact daemon…': 0,
  'Web Interface': 1,
  'The Pact daemon is ready': 2,
  'The Pact daemon is not ready': 3,

  // interfaces.ts
  'Web UI': 4,
  'Pact status UI & agent API': 5,
} as const

/**
 * Plumbing. DO NOT EDIT.
 */
export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
