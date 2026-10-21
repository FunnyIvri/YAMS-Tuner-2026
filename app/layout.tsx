import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google'
import { TooltipProvider } from '@/components/ui/tooltip'
import './globals.css'

const _plexSans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'] })
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''

const _plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'] })

export const metadata: Metadata = {
  title: 'YAMS Live Tuner — safe live tuning for FRC mechanisms',
  description:
    'Live tune YAMS elevators, arms, pivots and flywheels over NetworkTables 4, starting with a guided range-of-motion verification.',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: `${basePath}/icon-light-32x32.png`,
        media: '(prefers-color-scheme: light)',
      },
      {
        url: `${basePath}/icon-dark-32x32.png`,
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: `${basePath}/icon.svg`,
        type: 'image/svg+xml',
      },
    ],
    apple: `${basePath}/apple-icon.png`,
  },
}

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#e6e7e3',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="bg-background">
      <body className="font-sans antialiased">
        <TooltipProvider>{children}</TooltipProvider>
        {process.env.VERCEL && <Analytics />}
      </body>
    </html>
  )
}
