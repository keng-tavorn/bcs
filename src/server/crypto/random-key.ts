import { randomBytes } from 'node:crypto'

// Random identifiers that may be shown and sent in URLs but must not be guessable or reused.

/** 144 random bits → 24 base64url characters (the LINE_CHANNEL_KEY_PATTERN of src/server/queries/line-channel.ts) */
const CHANNEL_KEY_BYTES = 18

/**
 * LineChannelConfig.channelKey (§6.2): the public, random part of the organization's webhook URL
 * /api/webhooks/line/<channelKey>. Made once when the channel is first saved and never changed, so the URL registered at
 * LINE keeps working; random so the URL names no organization and cannot be enumerated.
 */
export function newChannelKey(): string {
  return randomBytes(CHANNEL_KEY_BYTES).toString('base64url')
}
