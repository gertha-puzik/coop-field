import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // Static export writes routes as <route>/index.html (not <route>.html),
  // so plain nginx dir-index serves /elision/ /combat/ /hunger/ without a 403.
  trailingSlash: true,
  images: { unoptimized: true },
  // Строгий режим сборки с W1: ошибки типов валят build, а не молчат.
  reactStrictMode: true,
  // Карта репо в AGENTS.md ведётся вручную. Без этого флага `next dev`
  // дописывает туда блок nextjs-agent-rules и пачкает рабочее дерево.
  agentRules: false,
};

export default nextConfig;
