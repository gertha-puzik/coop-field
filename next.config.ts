import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // Строгий режим сборки с W1: ошибки типов валят build, а не молчат.
  reactStrictMode: true,
};

export default nextConfig;
