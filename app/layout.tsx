import type { Metadata, Viewport } from 'next'
import { Courier_Prime, Inter, JetBrains_Mono, Press_Start_2P } from 'next/font/google'
import { TooltipProvider } from '@/components/ui/tooltip'
import './globals.css'

// The YASS website's fonts.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-jetbrains-mono' })
const courierPrime = Courier_Prime({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-courier-prime' })
const pressStart = Press_Start_2P({ subsets: ['latin'], weight: '400', variable: '--font-press-start' })
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''

/** Dark by default. Before the first paint, switch to light only if this browser chose it with the toggle. */
const themeScript = `try{if(localStorage.getItem("theme")==="light")document.documentElement.classList.remove("dark")}catch(e){}`

export const metadata: Metadata = {
  title: 'YAMS Live Tuner — safe live tuning for FRC mechanisms',
  description:
    'Live tune YAMS elevators, arms, pivots and flywheels over NetworkTables 4, starting with a guided range-of-motion verification.',
  generator: 'v0.app',
  icons: {
    icon: [
      { url: `${basePath}/favicon.ico`, sizes: 'any' },
      { url: `${basePath}/icon.png`, type: 'image/png', sizes: '64x64' },
    ],
    apple: `${basePath}/apple-icon.png`,
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: '#17191c',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${courierPrime.variable} ${pressStart.variable} dark bg-background`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-sans antialiased">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  )
}
