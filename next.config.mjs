import { readFileSync } from 'node:fs'

// When building for GitHub Pages the site is served from /<repo-name>,
// so the workflow sets NEXT_PUBLIC_BASE_PATH (e.g. "/YAMS-Tuner").
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''

// The version shown at the bottom of the page. The workflows and systemcore/build-ipk.sh set APP_VERSION to the
// package's version; a local build shows the version in package.json.
const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const appVersion = process.env.APP_VERSION || packageJson.version

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath,
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion,
  },
  trailingSlash: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
