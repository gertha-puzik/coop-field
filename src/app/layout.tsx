import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

const interSans = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin", "cyrillic"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Общее поле — симулятор CatWar",
  description:
    "Canvas-поле abnocw на общем WebSocket: до 30 котов в одной комнате.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body className={`${interSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}>
        {/* Тема ставится до первой отрисовки: иначе при светлой/пивной теме экран мигает тёмным. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('catwar-battle-sim-theme');if(t==='light'||t==='beer')document.documentElement.setAttribute('data-theme',t);}catch(e){}",
          }}
        />
        {children}
      </body>
    </html>
  );
}
