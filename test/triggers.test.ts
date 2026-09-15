import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  firstMatchingAlias,
  isBareAliasInvocation,
  isSilenceNarration,
  looksLikeBotStatsFooter,
  storedIdMatchesWaMsg,
} from '../src/gateway/trigger-alias.js'

const aliases = ['claude', 'amigo', 'heyamigo', 'clawd']

test('recognizes name-only trigger pings', () => {
  assert.equal(isBareAliasInvocation('claude', aliases), true)
  assert.equal(isBareAliasInvocation('  Claude?!  ', aliases), true)
  assert.equal(isBareAliasInvocation('@claude', aliases), true)
})

test('does not swallow real requests containing an alias', () => {
  assert.equal(isBareAliasInvocation('claude mf', aliases), false)
  assert.equal(isBareAliasInvocation('claude draft a message', aliases), false)
  assert.equal(isBareAliasInvocation('hey claude', aliases), false)
})

test('claude mentions still wake the agent so it can decide', () => {
  const chatter = [
    'und wie lädt claude die',
    'claude lädt gar nichts',
    'du feedest claude',
    'fix jetzt mal dein drecks bot damit es nicht auf claude reagiert',
    'hey claude',
    'claude, fix the bot',
  ]
  for (const text of chatter) {
    assert.equal(
      firstMatchingAlias(text, aliases),
      'claude',
      `should wake on: ${text}`,
    )
  }
})

test('unrelated chatter without an alias does not match', () => {
  assert.equal(firstMatchingAlias('wie sind die managed', aliases), null)
  assert.equal(firstMatchingAlias('sowas wie npm?', aliases), null)
})

test('detects bot stats footers vs owner quotes', () => {
  assert.equal(
    looksLikeBotStatsFooter('Done.\n\n_5.8s · grok-default · +digest_'),
    true,
  )
  assert.equal(
    looksLikeBotStatsFooter('The conversation is between Kamil and Cata\n\n_7.4s · grok-default_'),
    true,
  )
  assert.equal(looksLikeBotStatsFooter('und wie lädt claude die'), false)
  assert.equal(looksLikeBotStatsFooter('claude lädt gar nichts'), false)
})

test('maps stored outbound ids to the WhatsApp stanza', () => {
  assert.equal(storedIdMatchesWaMsg('outbound-12-ABCD', 'ABCD'), true)
  assert.equal(storedIdMatchesWaMsg('wa-owner-human-ABCD', 'ABCD'), false)
})

test('drops silence narration instead of posting it', () => {
  assert.equal(isSilenceNarration(''), true)
  assert.equal(isSilenceNarration('   '), true)
  assert.equal(isSilenceNarration('No reply.'), true)
  assert.equal(
    isSilenceNarration(
      'The conversation is between Kamil and Cata; this is not an invocation. Staying silent with no tags so nothing posts to the chat.',
    ),
    true,
  )
  assert.equal(
    isSilenceNarration("Kamil's talking to Cata, not invoking the bot. No reply."),
    true,
  )
  assert.equal(isSilenceNarration('Here is the actual answer you asked for.'), false)
})
