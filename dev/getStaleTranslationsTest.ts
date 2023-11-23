import getStaleTranslations from '../src/staleTranslations/getStaleTranslations'
import { testSanityClient } from './testSanityClient'

const response = await getStaleTranslations({
  translatableTypes: ['post'],
  sanityClient: testSanityClient,
  sourceDocs: [
    {
      _id: 'a2bafcca-fc41-4f4b-85c4-adb3307993d2',
      _rev: 'yblsDKVOfabu1vzRxm3I9j',
      _type: 'post',
      lang: 'en',
    },
    {
      _id: '29b6c10d-6c89-4f88-9132-aae1095ad65c',
      _rev: 'DdA5NPXuRVnUaTtbLvKVAR',
      _type: 'post',
      lang: 'en',
    },
  ],
  targetLangs: ['pt', 'es'],
})
console.log({ final: response })
