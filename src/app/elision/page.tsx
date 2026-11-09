"use client";

/**
 * Совместимый стаб старых ссылок (решение владелицы 2026-11-10): игровое
 * поле переехало с /elision/ на /game/. Сюда попадают устаревшие инвайт-
 * ссылки с query (?room=…&name=…) — на монтировании пересылаем на /game/
 * с сохранением строки запроса. noindex: заглушка не для индексации.
 */
import { useEffect } from "react";

export default function ElisionRedirect() {
  useEffect(() => {
    window.location.replace("/game/" + window.location.search);
  }, []);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#0a0e20] text-[#e8e4ff]">
      <meta name="robots" content="noindex" />
      <p>
        Игра переехала на <a className="underline" href="/game/">/game/</a>
      </p>
    </main>
  );
}
