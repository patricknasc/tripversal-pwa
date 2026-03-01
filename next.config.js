/** @type {import('next').NextConfig} */
const nextConfig = {
    async headers() {
        return [
            {
                source: '/(.*)',
                headers: [
                    // unsafe-none allows Google OAuth popup ↔ opener communication
                    {
                        key: 'Cross-Origin-Opener-Policy',
                        value: 'unsafe-none',
                    },
                ],
            },
        ];
    },
}

module.exports = nextConfig
