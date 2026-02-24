import type { Metadata, Viewport } from 'next'

export const metadata: Metadata = {
  title: 'Tripversal',
  description: 'Family travel companion app',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Tripversal',
  },
}

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, background: '#000', overscrollBehavior: 'none' }}>
        {children}
      </body>
    </html>
  )
}
