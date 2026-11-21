/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // Prevents double-mounting WebGL contexts during dev
  transpilePackages: ['@mwar/shared'],
  output: 'export',
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
