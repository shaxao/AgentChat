/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath: '/autocode',
  transpilePackages: ['@radix-ui/react-*', 'lucide-react'],
}

module.exports = nextConfig
