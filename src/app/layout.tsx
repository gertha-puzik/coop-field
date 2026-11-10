import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { PawCursor } from "@/components/ui";
import { PUBLIC_NAME } from "@/lib/net/modes";
import "./globals.css";

const interSans = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin", "cyrillic"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const description = "Общее поле на WebSocket: до 30 котов в одной комнате.";

export const metadata: Metadata = {
  title: { absolute: PUBLIC_NAME },
  description,
  openGraph: { title: PUBLIC_NAME, description },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body className={`${interSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}>
        {/* Тема ставится до первой отрисовки (ночью — тоже: от неё зависят
            CSS-правила [data-theme='night']), иначе мигает и теряются стили кнопок. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('catwar-battle-sim-theme');if(t!=='light'&&t!=='beer')t='night';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','night');}",
          }}
        />
        {/* Лапка-курсор поворачивается по направлению движения мыши
            (глобальный эффект, рендерит null — только слушатель). */}
        <PawCursor />
        {children}
      </body>
    </html>
  );
}
