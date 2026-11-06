import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // Строгий режим сборки с W1: ошибки типов валят build, а не молчат.
  reactStrictMode: true,
  // Карта репо в AGENTS.md ведётся вручную. Без этого флага `next dev`
  // дописывает туда блок nextjs-agent-rules и пачкает рабочее дерево.
  agentRules: false,
};

export default nextConfig;
