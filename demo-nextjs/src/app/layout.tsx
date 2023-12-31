import '~/styles/global.css'

import dynamic from 'next/dynamic'
import { IBM_Plex_Mono, Inter, PT_Serif } from 'next/font/google'
import { draftMode } from 'next/headers'

import { token } from '~/lib/sanity.fetch'

export const metadata = {
  title: '[DEMO] Phrase <> Sanity.io plugin',
  description: 'Generated by Next.js',
}

const mono = IBM_Plex_Mono({
  variable: '--font-family-mono',
  subsets: ['latin'],
  weight: ['500', '700'],
})

const sans = Inter({
  variable: '--font-family-sans',
  subsets: ['latin'],
  weight: ['500', '700', '800'],
})

const serif = PT_Serif({
  variable: '--font-family-serif',
  style: ['normal', 'italic'],
  subsets: ['latin'],
  weight: ['400', '700'],
})

const PreviewProvider = dynamic(() => import('~/components/PreviewProvider'))

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      className={[mono, sans, serif].map((a) => a.variable).join(' ')}
    >
      <body>
        {draftMode().isEnabled ? (
          <PreviewProvider token={token}>{children}</PreviewProvider>
        ) : (
          children
        )}
      </body>
    </html>
  )
}
