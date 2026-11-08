import type { Metadata } from "next";
import Simulator from "@/components/sim/simulator";
import { ThemeSelect } from "@/components/site/theme-select";

export const metadata: Metadata = {
  title: "Wanderpaws: Elysiae",
  description: "Твой путь начинается здесь. Закрытая локация: мирная ходьба, редактор, сутки. Нужен аккаунт.",
};

export default function ElisionPage() {
  return (
    <>
      <Simulator mode="elision" />
      {/* Компакт-селект темы поверх симулятора: фиксированный слот в правом
          верхнем углу экрана входа. На самом поле селект уже есть в хроме
          симулятора — слот прячет себя через CSS (body:has(header.shrink-0)),
          чтобы не дублировать и не перекрывать кнопки хрома. */}
      <div className="elision-theme-slot">
        <ThemeSelect />
      </div>
    </>
  );
}
