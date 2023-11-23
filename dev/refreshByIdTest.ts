import refreshPTDById from '../src/refreshTranslation/refreshPTDById'
import { testCredentials } from './testCredentials'
import { testSanityClient } from './testSanityClient'

const response = await refreshPTDById({
  sanityClient: testSanityClient,
  credentials: testCredentials,
  ptdId: 'drafts.phrase-translation--pt--__root__bvdFY8iWN5ZXtp8P51v4bf',
})

console.log({ final: response })