import { PortableTextTextBlock } from 'sanity'
import { SerializedPtBlock, SerializedPtHtmlTag } from './types'
import { encodeHTML } from 'entities'

/**
 * We can't simply send a Sanity document to Phrase as-is:
 *
 * - PortableText needs to be serialized to HTML so linguists can see the full
 *   paragraphs in context as opposed to individual PT spans
 *
 * - We must escape any HTML-like characters in strings to avoid having Phrase
 *   parse them as HTML
 */
export default function encodeToPhrase<C = unknown>(content: C): C {
  if (Array.isArray(content)) {
    return content.map((c) => encodeToPhrase(c)) as C
  }

  if (typeof content === 'object' && content !== null) {
    if ('_type' in content && content._type === 'block') {
      return serializeBlock(content as any as PortableTextTextBlock) as C
    }

    return Object.fromEntries(
      Object.entries(content).map(([key, value]) => [
        key,
        encodeToPhrase(value),
      ]),
    ) as C
  }

  if (typeof content === 'string') {
    return prepareStringForPhrase(content) as C
  }

  return content as C
}

function prepareStringForPhrase(str: string) {
  return encodeHTML(str)
}

/**
 * How it works:
 * - renders every span as <s data-key="SPAN_KEY">
 * - renders every inline block as <c-b data-key="BLOCK_KEY">
 * - extract inline blocks & spans' meta as JSON outside of the HTML
 */
function serializeBlock(block: PortableTextTextBlock): SerializedPtBlock {
  const { children = [], markDefs = [], ...metadata } = block

  /**
   * Machine-oriented meta fields for the block: _type, style, markDefs, listItem, level.
   * `_` prefix indicates it's ignored by Phrase - will be sent and imported back as is.
   *
   * @docs https://github.com/portabletext/portabletext#block
   */
  const _blockMeta = metadata

  /**
   * Maps span keys to their full metadata, beyond their text content.
   * `_` prefix indicates it's ignored by Phrase - will be sent and imported back as is.
   * Translatable, human-readable data that could exist in a span's metadata is found in `markDefs`.
   *
   * @docs https://github.com/portabletext/portabletext#span
   */
  const _spanMeta = children.reduce((metaAcc, span) => {
    if (span._type !== 'span') return metaAcc

    return {
      ...metaAcc,
      [span._key]: {
        ...span,
        text: undefined,
      },
    }
  }, {})

  /**
   * Similar to spanMeta, but for inline blocks.
   * Analyzed by Phrase for human-readable properties like an inline image's `alt`.
   *
   * @docs https://github.com/portabletext/portabletext#custom-blocks
   */
  const inlineBlocksData = children.reduce((metaAcc, child) => {
    if (child._type === 'span') return metaAcc

    return {
      ...metaAcc,
      [child._key]: child,
    }
  }, {})

  const serializedHtml = children
    .map((child) => {
      if (child._type === 'span') {
        return `<${SerializedPtHtmlTag.SPAN} data-key="${
          child._key
        }">${prepareStringForPhrase((child.text as string) || '')}</${
          SerializedPtHtmlTag.SPAN
        }>`
      }

      return `<${SerializedPtHtmlTag.BLOCK} data-key="${child._key}"></${SerializedPtHtmlTag.BLOCK}>`
    })
    .join('\n')

  return {
    _type: 'block',
    _blockMeta,
    _spanMeta,
    inlineBlocksData,
    serializedHtml,

    /** Analyzed by Phrase for human-readable properties like a link's `title` */
    markDefs,
  }
}
