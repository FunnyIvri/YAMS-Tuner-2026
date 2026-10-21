// When building for GitHub Pages the site is served from /<repo-name>,
// so the workflow sets NEXT_PUBLIC_BASE_PATH (e.g. "/YAMS-Tuner").
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath,
  trailingSlash: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
